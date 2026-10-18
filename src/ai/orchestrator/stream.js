/**
 * Safe streaming (Phase 14): the model's tokens reach the visitor sentence by
 * sentence, and every sentence goes through the same grounding check as the
 * final answer first — so an invented price can't flash on screen and be
 * removed later. The FOLLOWUPS line is held back (it becomes chips).
 *
 * The final, authoritative text is still built from the whole answer at the
 * end; the widget replaces the streamed text with it.
 */

const { ground, looksLikeToolCall } = require('./grounding');

// End of a sentence: . ! ? or a line break, followed by space/end. Not "e.g." or "1.5".
const BOUNDARY = /([.!?…])(\s+)(?=[A-Z0-9"“(*•\-–]|$)|\n+/g;
const HOLD = /\n?\s*(?:F(?:O(?:L(?:L(?:O(?:W(?:[- ]?(?:U(?:P(?:S(?::)?)?)?)?)?)?)?)?)?)?|S(?:U(?:G(?:G(?:E(?:S(?:T(?:I(?:O(?:N(?:S(?::)?)?)?)?)?)?)?)?)?)?)?)$/i;

function createSafeStream({ evidence, emit }) {
  let buffer = '';
  let stopped = false;
  let sent = '';

  function flush(final = false) {
    if (stopped) return;
    // At the start of the buffer too: the newline before it may have gone out with the last sentence.
    const fu = buffer.search(/(?:^|\n)\s*(?:FOLLOW[- ]?UPS?|SUGGESTIONS?)\s*:/i);
    if (fu >= 0) {
      buffer = buffer.slice(0, fu);
      stopped = true;
      final = true;
    }
    // An answer that starts like JSON may be a tool call written as text: hold
    // it to the end, and send nothing if it is one.
    if (!sent && /^\s*[{[]/.test(buffer)) {
      if (!final) return;
      if (looksLikeToolCall(buffer)) { buffer = ''; stopped = true; return; }
    }
    let cut = -1;
    if (final) cut = buffer.length;
    else {
      let m;
      BOUNDARY.lastIndex = 0;
      while ((m = BOUNDARY.exec(buffer))) cut = m.index + m[0].length;
      // A trailing fragment that might be the start of "FOLLOWUPS:" stays in the buffer.
      if (cut < 0 && HOLD.test(buffer)) return;
    }
    if (cut <= 0) return;
    const piece = buffer.slice(0, cut);
    buffer = buffer.slice(cut);
    const safe = ground(piece, evidence).text;
    const out = /\s$/.test(piece) && !/\s$/.test(safe) ? `${safe} ` : safe;
    if (out.trim()) {
      sent += out;
      emit(out);
    }
  }

  return {
    push(delta) {
      if (stopped) return;
      buffer += delta;
      flush(false);
    },
    end() {
      flush(true);
      return sent;
    },
  };
}

module.exports = { createSafeStream };
