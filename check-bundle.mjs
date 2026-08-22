import { readFile } from 'fs/promises';
const token = await (await fetch('http://localhost:13000/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'seed-admin', password: 'Admin@123456' }) }).then(r=>r.json())).accessToken;
const res = await fetch('http://localhost:13000/api/v1/docs-site/t_0000000001/prototypes/44337dbf-d6b4-4d5a-b3aa-08b4bec3dd7d/index.tsx', { headers: { Authorization: `Bearer ${token}` } });
const text = await res.text();
console.log('source length', text.length);
console.log(text.slice(0,500));
import * as esbuild from '/Users/mac/01work/git-project/vteam/web/node_modules/esbuild-wasm/lib/main.js';
await esbuild.initialize({ wasmURL: 'file:///Users/mac/01work/git-project/vteam/web/public/esbuild/esbuild.wasm' });
const result = await esbuild.build({
  stdin: { contents: text, loader: 'tsx', sourcefile: 'prototype/index.tsx', resolveDir: '/' },
  bundle: true,
  format: 'iife',
  globalName: '__ProtoModule',
  jsx: 'transform',
  charset: 'utf8',
  target: 'es2017',
  logLevel: 'silent',
  write: false,
  plugins: [{
    name: 'test',
    setup(build) {
      build.onResolve({ filter: /^react(\/.*)?$/ }, args => {
        if (args.path === 'react' || args.path === 'react/jsx-runtime' || args.path === 'react/jsx-dev-runtime') return { path: args.path, namespace: 'react-ns' };
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: 'react-ns' }, () => ({ loader: 'js', contents: 'export default globalThis.React; export const useState = globalThis.React.useState;' }));
    }
  }]
});
const out = result.outputFiles[0].text;
console.log('out length', out.length);
console.log('has </script', out.includes('</script'));
console.log('has </', out.includes('</'));
console.log(out.slice(0,1000));
