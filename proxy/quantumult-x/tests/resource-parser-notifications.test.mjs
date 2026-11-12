import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../resource-parser.js', import.meta.url), 'utf8');
const valid = 'trojan=example.com:443, password=test-secret, over-tls=true, tls-verification=true, tag=working';
const invalid = 'vmess://bm90LWpzb24=#broken';
const unsupported = 'hysteria2://test-secret@example.com:443#unsupported';

function run(content, {hash='', type='server', build=946, userAgent='', terminate=false}={}) {
  const notifications=[], completions=[], events=[];
  const stopped={};
  const context=vm.createContext({
    $resource:{link:'https://example.invalid/sub?token=private-token'+hash, content, type, tag:'Test subscription', user_agent:userAgent},
    $environment:{version:`Quantumult X 1.8.0 build${build}`},
    $notify:(...args)=>{notifications.push(args);events.push('notify');},
    $done:value=>{completions.push(value);events.push('done');if(terminate)throw stopped;},
    console:{log(){}},
  });
  try { vm.runInContext(source,context,{timeout:5000}); } catch(error) {if(error!==stopped)throw error;}
  const reports=notifications.filter(n=>/订阅解析(?:完成|失败|有异常|已修复)/.test(n[0]));
  assert.equal(completions.length,1,'exactly one host completion');
  assert.equal(events.at(-1),'done','summary precedes the terminating host call');
  const text=reports[0]?.join('\n') || '';
  assert.ok(!text.includes('test-secret')&&!text.includes('private-token'),'summary must not include credentials');
  return {reports,text,notifications,result:completions[0],state:context.ParserRun,events};
}

test('success summary reports generated nodes, version, and native acceptance caveat',()=>{
  const r=run(valid,{terminate:true});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/✅ 订阅解析完成/);
  assert.match(r.text,/原始条目：1 · 输出条目：1/);
  assert.match(r.text,/生成节点：1 · 信息占位：0/);
  assert.match(r.text,/实际以订阅列表为准/);
  assert.match(r.text,/2026-11-12\.2/);
  assert.doesNotMatch(r.text,/成功转换/);
});

test('partial failure and unsupported nodes stay visible even with ntf=0',()=>{
  const r=run([valid,invalid,unsupported,'not a node','  # ignored comment'].join('\n'),{hash:'#ntf=0'});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/⚠️ 订阅解析有异常/);
  assert.match(r.text,/原始条目：4 · 输出条目：1/);
  assert.match(r.text,/转换失败：2 · 不支持：1 · 筛除\/去重：0/);
  assert.match(r.text,/broken — 转换异常（SyntaxError）/);
});

test('all-invalid input emits a failed summary with no fake success',()=>{
  const r=run(invalid,{hash:'#ntf=0',terminate:true});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/❌ 订阅解析失败/);
  assert.match(r.text,/生成节点：0/);
  assert.match(r.text,/转换失败：1/);
  assert.equal(r.result.content,'');
});

test('unsupported-only subscriptions are counted, including the hy2 alias',()=>{
  for(const uri of [unsupported,unsupported.replace('hysteria2:','hy2:')]) {
    const r=run(uri);
    assert.equal(r.reports.length,1);
    assert.match(r.text,/原始条目：1/);
    assert.match(r.text,/转换失败：0 · 不支持：1/);
  }
});

test('empty response still produces a zero-count failure summary',()=>{
  const r=run('');
  assert.equal(r.reports.length,1);
  assert.match(r.text,/❌ 订阅解析失败/);
  assert.match(r.text,/原始条目：0 · 输出条目：0/);
  assert.match(r.text,/内容为空/);
});

test('malformed Clash JSON is caught during format detection',()=>{
  const r=run('{"proxies": [ }',{terminate:true});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/❌ 订阅解析失败/);
  assert.match(r.text,/原始条目：无法统计/);
  assert.match(r.text,/中断阶段：格式识别/);
  assert.equal(r.result.content,'');
});

test('malformed URL parameters are caught before ordinary counters initialize',()=>{
  const r=run(valid,{hash:'#in=%ZZ',terminate:true});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/中断阶段：初始化参数（URIError）/);
  assert.match(r.text,/生成节点：0/);
  assert.equal(r.result.content,'');
});

test('invalid regex is reported as an interrupted run, not success',()=>{
  const r=run(valid,{hash:'#regex=%5B'});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/❌ 订阅解析失败/);
  assert.match(r.text,/中断阶段：节点筛选与重命名/);
  assert.equal(r.result.content,'');
});

test('user filters and duplicate removal are separate from conversion failures',()=>{
  const other=valid.replace('tag=working','tag=other');
  for(const [input,hash,remaining,filtered] of [
    [[valid,other].join('\n'),'#in=working',1,1],
    [[valid,other].join('\n'),'#in=absent',0,2],
    [[valid,valid].join('\n'),'#del=1',1,1],
  ]) {
    const r=run(input,{hash});
    assert.equal(r.reports.length,1);
    assert.match(r.text,new RegExp(`生成节点：${remaining}`));
    assert.match(r.text,new RegExp(`转换失败：0 · 不支持：0 · 筛除/去重：${filtered}`));
  }
});

test('two adapter placeholders are separate from real nodes',()=>{
  const r=run([valid,'http=127.0.0.1:1, udp-relay=false, tag=剩余流量：10 MB','http=127.0.0.1:2, udp-relay=false, tag=到期时间：1999-01-01'].join('\n'));
  assert.match(r.text,/原始条目：3 · 输出条目：3/);
  assert.match(r.text,/生成节点：1 · 信息占位：2/);
  assert.match(r.text,/转换失败：0/);
});

test('repairs are counted per node rather than per field',()=>{
  const r=run(valid.replace(', tag=',', tls-cert-sha256=, tls-pubkey-sha256=, tag='));
  assert.match(r.text,/🛠 订阅解析已修复/);
  assert.match(r.text,/已修复空证书指纹：1 个节点/);
});

test('Clash failures and unsupported types do not stop healthy nodes or double-count',()=>{
  const r=run(JSON.stringify({proxies:[
    {name:'ok',type:'trojan',server:'example.com',port:443,password:'test-secret'},
    null,
    {name:'unsupported',type:'hysteria2',server:'example.com',port:443,password:'test-secret'},
  ]}),{hash:'#udp=1&tfo=1'});
  assert.equal(r.reports.length,1);
  assert.match(r.text,/原始条目：3 · 输出条目：1/);
  assert.match(r.text,/转换失败：1 · 不支持：1/);
});

test('old app version exclusions are classified as unsupported',()=>{
  const r=run('anytls://test-secret@example.com:443#old-app',{build:900});
  assert.match(r.text,/转换失败：0 · 不支持：1/);
});

test('failure detail list is bounded',()=>{
  const r=run(Array.from({length:8},(_,i)=>invalid.replace('#broken',`#broken-${i}`)).join('\n'));
  assert.match(r.text,/转换失败：8/);
  assert.equal((r.text.match(/broken-/g)||[]).length,5);
});

test('base64 subscriptions retain the same counts',()=>{
  const r=run(Buffer.from([valid,invalid].join('\n')).toString('base64'));
  assert.match(r.text,/原始条目：2 · 输出条目：1/);
  assert.match(r.text,/转换失败：1/);
});

test('retry request is not reported as a completed or failed parse',()=>{
  const r=run(valid,{hash:'#UA=1'});
  assert.equal(r.reports.length,0);
  assert.ok(r.result.retry);
  const after=run(valid,{hash:'#UA=1',userAgent:'Shadowrocket/test'});
  assert.equal(after.reports.length,1);
});

test('rewrite and filter resources do not receive node summaries',()=>{
  const rewrite=run('^https://example.com/ad url reject',{type:'rewrite'});
  const filter=run('host, example.com, direct',{type:'filter'});
  assert.equal(rewrite.reports.length,0);
  assert.equal(filter.reports.length,0);
  assert.match(rewrite.result.content,/url reject/);
  assert.match(filter.result.content,/example.com/);
});

test('custom script failures keep their fallback and remain warnings in the final report',()=>{
  const script=Buffer.from('throw new Error("test-secret")').toString('base64');
  for(const parameter of ['sfilter','srename']) {
    const r=run(valid,{hash:`#ntf=0&${parameter}=${script}`});
    assert.equal(r.reports.length,1);
    assert.match(r.text,/⚠️ 订阅解析有异常/);
    assert.match(r.text,/生成节点：1/);
    assert.match(r.text,/警告 1/);
    assert.match(r.text,/失败（Error），已保留/);
    assert.ok(!JSON.stringify(r.notifications).includes('test-secret'));
  }
});

test('successful custom scripts still filter and rename before the summary',()=>{
  const filter=Buffer.from('function filter(nodes){return nodes.names.map((_,i)=>i===0)}').toString('base64');
  const rename=Buffer.from('function rename(nodes){return nodes.names.map(()=>"renamed")}').toString('base64');
  const r=run([valid,valid.replace('tag=working','tag=other')].join('\n'),{hash:`#sfilter=${filter}&srename=${rename}`});
  assert.match(r.text,/✅ 订阅解析完成/);
  assert.match(r.text,/生成节点：1/);
  assert.match(r.text,/筛除\/去重：1/);
  assert.match(Buffer.from(r.result.content,'base64').toString(),/tag=renamed/);
});

test('malformed native entries are counted without dumping their credentials',()=>{
  const r=run([valid,valid.replace('tag=working','tag-broken')].join('\n'));
  assert.match(r.text,/转换失败：1/);
  assert.match(r.text,/节点格式异常（TypeError）/);
  assert.ok(!JSON.stringify(r.notifications).includes('test-secret'));
});
