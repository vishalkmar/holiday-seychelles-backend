const { test } = require('node:test');
const assert = require('node:assert/strict');
const { guardNames, namesIn } = require('./names');

test('names: a remembered resort is removed, the rest of the answer stays', () => {
  const r = guardNames('Four Seasons Resort Seychelles is the best on Mahé. Tell me your dates and I will search live options.', 'best 5 star resort in mahe');
  assert.equal(r.text, 'Tell me your dates and I will search live options.');
  assert.equal(r.removed[0].kind, 'name');
});

test('names: names from tool results or knowledge are kept', () => {
  const known = JSON.stringify({ items: [{ name: 'The Ridge Residence' }, { name: 'Semi-Submarine Tour' }] }) + ' Vallée de Mai is a UNESCO site.';
  const text = 'The Ridge Residence is a good match for two adults. The Semi-Submarine Tour runs on your day.';
  assert.deepEqual(guardNames(text, known), { text, removed: [] });
});

test('names: other booking sites are removed unless we say we do not use them', () => {
  assert.equal(guardNames('You can also compare prices on Booking.com. Or tell me your dates.', '').text, 'Or tell me your dates.');
  const ok = "I can't search booking.com, but I can show our live hotels.";
  assert.equal(guardNames(ok, '').text, ok);
});

test('names: places, generic words and our own name are not product names', () => {
  assert.deepEqual(namesIn('Praslin is famous for the Vallée de Mai and Anse Lazio.'), []);
  assert.deepEqual(namesIn('Holidays Seychelles can show Beach Resorts and Luxury Hotels on Mahé.'), []);
  assert.deepEqual(namesIn('Boat tours and snorkelling trips run most days.'), []);
});

test('names: restaurants and tour operators from memory are removed', () => {
  assert.equal(guardNames('Try Marie Antoinette Restaurant in Victoria. Local takeaways are great value.', 'best restaurants in victoria').text, 'Local takeaways are great value.');
  assert.equal(guardNames('Blue Sea Divers is a good choice.', '').text, '');
});

test('names: the visitor may name a hotel and get an honest reply', () => {
  const r = guardNames('I can check if Constance Ephelia has rooms on your dates.', 'is constance ephelia available');
  assert.equal(r.removed.length, 0);
});

test('names: brands in the visitor message mark a hotel request', () => {
  const { hasBrand } = require('./names');
  assert.ok(hasBrand('Is Four Seasons Mahé better than Constance Ephelia?'));
  assert.ok(!hasBrand('What is the best time to visit Praslin?'));
});
