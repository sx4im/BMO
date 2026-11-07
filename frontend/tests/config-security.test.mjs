import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleLoader } from './modules.mjs';

test('production uses the deployed gateway and ignores stale browser origin overrides',async t=>{
  const app=moduleLoader({'deployment.js':{deployment:{apiUrl:'https://gateway.example.invalid',turnstileSiteKey:'public-fixture'}}});
  t.after(()=>app.dom.window.close());
  app.dom.window.localStorage.setItem('bimo-config',JSON.stringify({apiUrl:'https://old.onrender.com'}));
  const {config}=await app.load('js/config.js');
  assert.equal(config.apiUrl,'https://gateway.example.invalid');
});

test('production does not silently fall back to a direct Render origin or relative API',async t=>{
  for(const apiUrl of ['', 'https://old.onrender.com', 'http://gateway.example.invalid']) {
    const app=moduleLoader({'deployment.js':{deployment:{apiUrl}}});
    t.after(()=>app.dom.window.close());
    const {config}=await app.load('js/config.js');
    assert.throws(()=>config.apiUrl);
  }
});
