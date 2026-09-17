const test=require('node:test'),assert=require('node:assert/strict');
const iconv=require('iconv-lite');
const {decodeDiagnostic,DiagnosticDecoder,readDiagnosticResponse}=require('../dist/main/encoding/DiagnosticDecoder');
const {ProcessManager}=require('../dist/main/tools/shell/ProcessManager');

test('diagnostic byte decoding preserves UTF8, GBK, GB18030, UTF16 BOM and literal replacement characters',()=>{
 const text='错误：系统找不到指定路径。中文😀';
 for(const encoding of ['utf8','gb18030','utf16le','utf16be']) {
  const bytes=iconv.encode(text,encoding,{addBOM:encoding.startsWith('utf16')});assert.equal(decodeDiagnostic(bytes),text,encoding);
 }
 const gbk='错误：系统找不到指定路径。';assert.equal(decodeDiagnostic(iconv.encode(gbk,'gbk')),gbk);
 assert.equal(decodeDiagnostic(Buffer.from('合法替换字符 � 中文')),'合法替换字符 � 中文');
 assert.equal(decodeDiagnostic(iconv.encode('café','windows-1252'),'windows-1252'),'café');
});

test('diagnostic pipe decoder keeps every UTF8/GBK multibyte split intact, including unterminated final lines',()=>{
 for(const encoding of ['utf8','gbk','gb18030']) {
  const text='错误：参数无效\r\n第二行：文件不存在。';const bytes=iconv.encode(text,encoding);
  for(let split=1;split<bytes.length;split++){const decoder=new DiagnosticDecoder();assert.equal(decoder.write(bytes.subarray(0,split))+decoder.write(bytes.subarray(split))+decoder.end(),text,`${encoding}/${split}`);assert.equal(decoder.end(),'');}
  const decoder=new DiagnosticDecoder();let result='';for(const byte of bytes)result+=decoder.write(Buffer.from([byte]));assert.equal(result+decoder.end(),text);
 }
});

test('HTTP diagnostics honor declared GBK and recover undeclared legacy gateway error bodies',async()=>{
 const bytes=iconv.encode('上游网关错误：服务暂时不可用','gbk');
 assert.equal(await readDiagnosticResponse(new Response(bytes,{headers:{'content-type':'text/plain; charset=GBK'}})),'上游网关错误：服务暂时不可用');
 assert.equal(await readDiagnosticResponse(new Response(bytes)),'上游网关错误：服务暂时不可用');
});

test('actual process captures split GBK stderr and UTF8 stdout without corrupting either channel',async()=>{
 const message='错误：测试文件不存在。',hex=iconv.encode(message,'gbk').toString('hex');
 const source=`process.stdout.write('UTF8 '+String.fromCodePoint(20013,25991));const b=Buffer.from('${hex}','hex');let i=0;const t=setInterval(()=>{process.stderr.write(b.subarray(i,i+1));if(++i===b.length){clearInterval(t);process.exitCode=2;}},1)`;
 const command=`"${process.execPath}" -e "${source}"`;
 const result=await new ProcessManager().run(command,process.cwd(),new AbortController().signal,{timeoutMs:10000,maxOutputBytes:100000,killGracePeriodMs:100},process.platform==='win32'?'cmd':'auto');
 assert.equal(result.exitCode,2);assert.equal(result.success,false);assert.ok(result.output.includes(message),result.output);assert.ok(result.output.includes('UTF8 中文'),result.output);
});

test('malformed unbroken diagnostic output remains bounded instead of accumulating indefinitely',()=>{
 const decoder=new DiagnosticDecoder();let count=0;
 for(let i=0;i<8;i++){count+=decoder.write(Buffer.alloc(70000,255)).length;assert.ok(decoder.pending.length<=4);}
 assert.ok(count>0);assert.ok(decoder.end().length<=4);
});
