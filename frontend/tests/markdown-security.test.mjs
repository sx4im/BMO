import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import createDOMPurify from '../vendor/dompurify/purify.es.mjs';

test('the shipped sanitizer removes executable content while preserving ordinary formatting',t=>{
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());
  const purify=createDOMPurify(dom.window);
  assert.equal(purify.version,'3.4.17');
  for(const source of [
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">link</a><script>alert(1)</script>',
    '<svg><g onload="alert(1)"></g></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<form><input name="__proto__"><input name="constructor"></form>',
  ]) {
    const target=dom.window.document.querySelector('main');target.innerHTML=purify.sanitize(source);
    assert.equal(target.querySelector('script,object,embed,iframe'),null);
    for(const node of target.querySelectorAll('*'))for(const attribute of node.attributes) {
      assert.equal(/^on/i.test(attribute.name),false);
      assert.equal(/^\s*javascript:/i.test(attribute.value),false);
    }
  }
  assert.equal(purify.sanitize('<p><strong>Useful</strong> <code>x &lt; y</code></p>'),'<p><strong>Useful</strong> <code>x &lt; y</code></p>');
});
