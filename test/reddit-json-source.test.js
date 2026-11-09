import test from 'node:test';
import assert from 'node:assert/strict';
import { RedditJsonSource, parseRedditJson } from '../src/reddit-json-source.js';
const post = { name: 't3_sale', id: 'sale', subreddit: 'fragranceswap', title: '[WTS] Bottles', selftext: '~~Creed Aventus 100ml $100~~\n' + 'x'.repeat(2000), created_utc: 1700000000, permalink: '/r/fragranceswap/comments/sale/bottles/', link_flair_text: null, removed_by_category: null };
const payload = (data = post) => ({ kind: 'Listing', data: { children: [{ kind: 't3', data }] } });
test('JSON retains full markdown and sold/removal metadata, validates authoritative bodies', () => {
  assert.equal(parseRedditJson(payload(), 'fragranceswap')[0].selftext, post.selftext);
  for (const change of [{link_flair_text:'SOLD'}, {removed_by_category:'moderator'}, {selftext:'[deleted]'}]) assert.equal(parseRedditJson(payload({...post,...change}), 'fragranceswap')[0].unavailable, true);
  for (const change of [{selftext:undefined}, {subreddit:'other'}, {permalink:'https://evil.example/r/fragranceswap/comments/sale/'}]) assert.throws(()=>parseRedditJson(payload({...post,...change}), 'fragranceswap'));
  assert.throws(()=>parseRedditJson([payload()], 'fragranceswap','t3_other'));
});
test('JSON batches discovery, alternates older refreshes, preserves spacing across restarts and refuses redirects', async () => {
  let clock = 1700001000000;
  let state;
  const calls=[];
  const options={subreddit:'fragranceswap',loadCookie:async()=> 'reddit_session=test',now:()=>clock,getState:()=>state,saveState:async(value)=>{state=value;},fetchImpl:async(url,opts)=>{calls.push({url:String(url),opts});return Response.json(payload({...post,created_utc:(clock-1000)/1000}));}};
  let source=new RedditJsonSource(options);
  const posts=await source.fetchPosts();
  assert.equal(posts.length,1);
  assert.match(calls[0].url,/new.json/);
  await source.acknowledgePost(posts[0],true);
  source=new RedditJsonSource(options);
  await assert.rejects(source.fetchPosts(),/request interval/);
  clock+=31*60000;
  await source.fetchPosts();
  assert.match(calls[1].url,/comments\/sale.json/);
  clock+=90000;
  await source.fetchPosts();
  assert.match(calls[2].url,/new.json/);
  assert.equal(calls[2].opts.redirect,'manual');
  clock+=90000;
  source=new RedditJsonSource({...options,fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://example.com'}})});
  await assert.rejects(source.fetchPosts(),/redirected/);
  assert.equal(state.lastRequestAt,clock);
});

test('failed discoveries remain discoveries across restart until a valid batch succeeds', async () => {
  let clock = 1700001000000;
  let state;
  let failDiscovery = false;
  const calls = [];
  const options = {
    loadCookie: async () => 'reddit_session=test', now: () => clock,
    getState: () => state, saveState: async (value) => { state = value; },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (failDiscovery && String(url).includes('/new.json')) return new Response('Denied', { status: 403 });
      return Response.json(payload({ ...post, created_utc: (clock - 1000) / 1000 }));
    },
  };
  let source = new RedditJsonSource(options);
  const [discovered] = await source.fetchPosts();
  await source.acknowledgePost(discovered, true);
  clock += 31 * 60000;
  await source.fetchPosts(); // An older-post refresh succeeds.
  const lastDiscoveryAt = state.lastDiscoveryAt;
  failDiscovery = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    clock += 90000;
    source = new RedditJsonSource(options);
    await assert.rejects(source.fetchPosts(), (error) => error.status === 403);
    assert.match(calls.at(-1), /new\.json/);
    assert.equal(state.lastDiscoveryAt, lastDiscoveryAt);
  }
  failDiscovery = false;
  clock += 90000;
  await source.fetchPosts();
  assert.match(calls.at(-1), /new\.json/);
  assert.equal(state.lastDiscoveryAt, clock);
  clock += 90000;
  await source.fetchPosts();
  assert.match(calls.at(-1), /comments\/sale\.json/);
});
