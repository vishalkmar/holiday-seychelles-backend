/**
 * Publish scheduled posts.
 *
 * A post scheduled for Tuesday morning has to appear without anybody signing
 * in, so a tick moves anything whose time has passed to `published`.
 *
 * The move is one conditional UPDATE rather than select-then-update: the WHERE
 * clause is the lock, so two ticks overlapping cannot publish the same post
 * twice or fight over its published_at.
 */

const cron = require('node-cron');
const { pool } = require('../config/db');

async function publishDuePosts() {
  const result = await pool.query(
    `UPDATE blogs
        SET status = 'published',
            published_at = COALESCE(published_at, scheduled_for),
            scheduled_for = NULL,
            updated_at = NOW()
      WHERE status = 'scheduled'
        AND scheduled_for IS NOT NULL
        AND scheduled_for <= NOW()`
  );

  if (result.rowCount) {
    console.log(`[blogs] published ${result.rowCount} scheduled post(s)`);
  }
  return { published: result.rowCount || 0 };
}

/**
 * Every five minutes.
 *
 * Fine-grained enough that "publish at 9am" means 9am to anyone reading, and
 * coarse enough not to poke a database that dislikes chatter.
 */
function startBlogScheduler() {
  if (String(process.env.BLOG_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'true') {
    console.log('[blogs] scheduler disabled (BLOG_SCHEDULER_ENABLED=false)');
    return null;
  }

  const expression = process.env.BLOG_SCHEDULER_CRON || '*/5 * * * *';
  if (!cron.validate(expression)) {
    console.error(`[blogs] invalid BLOG_SCHEDULER_CRON "${expression}" - scheduler not started`);
    return null;
  }

  const task = cron.schedule(expression, async () => {
    try {
      await publishDuePosts();
    } catch (err) {
      console.error('[blogs] scheduler tick failed:', err.message);
    }
  });
  console.log(`[blogs] scheduler running "${expression}"`);
  return task;
}

module.exports = { publishDuePosts, startBlogScheduler };
