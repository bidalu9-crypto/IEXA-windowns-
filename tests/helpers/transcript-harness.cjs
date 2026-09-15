const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../..');const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
const tree=ts.createSourceFile('app.js',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function functions(names){return tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(tree)).join('\n');}
function create(t){
 const dom=new JSDOM('<body><div id="messages"></div></body>',{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost'});if(t)t.after(()=>dom.window.close());const w=dom.window;
 for(const f of ['ChatActivityView','TranscriptView'])w.eval(fs.readFileSync(path.join(root,`src/renderer/services/${f}.js`),'utf8'));
 const message=w.document.createElement('div');message.className='message assistant';message._assistantText='';message.innerHTML='<div class="message-content"></div><div class="assistant-message-footer"></div>';w.document.getElementById('messages').appendChild(message);
 Object.assign(w,{currentAssistantMsg:message,currentSessionId:'s',visibleSessionId:'s',currentToolBlocks:{},currentTaskToolCount:0,currentThinkingLevel:'medium',activeChatTurnToken:1,currentTaskSummary:null,
  ensureAssistantMessage:()=>w.currentAssistantMsg,assistantFooterAnchor:msg=>msg.querySelector('.assistant-message-footer'),scrollToBottom:()=>{},shouldFollowLatestMessage:()=>true,snapshotActiveSessionRuntime:()=>{},withSessionRuntime:(_s,fn)=>fn(),
  uiIcon:name=>`<svg class="ui-icon"><use href="#ui-${name}"/></svg>`,escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  thinkingEffortLabelFor:()=> '标准',normalizeThinkingLevel:value=>value,updateThinkingTokenCount:()=>{},stabilizeThinkingBlockWidth:()=>{},toolKind:()=> 'file',toolIcon:()=>'',toolDisplayName:name=>name,toolMeta:()=>'',toolLiveTitle:name=>name,
  beginTaskSummary:()=>{},updateTaskSummary:()=>{},createTaskSummary:()=>{const n=w.document.createElement('button');n.className='task-summary';return n;},
  renderMarkdownContent:(node,text)=>{node._markdownSource=text;node.textContent=text;},setPagedText:(node,text)=>{node._fullText=String(text);node.textContent=text;},
 });
 w.pendingStreamUpdates = new Map();
 w.eval(functions(['handleTextDelta','handleThinkingDelta','handleToolStart','handleToolComplete','ensureToolStepsHost','ensureAnswerContentEl','hideWaitingIndicator','finishActiveThinkingBlock','finishThinkingBlock','initializeThinkingAutoScroll','scrollThinkingToLatest','setToolStepStatus','restoreTranscriptOrder','queueStreamUpdate','flushStreamUpdates']));
 return {w,message,dom};
}
function flatten(message){const out=[];for(const n of message.children){if(n.matches('.message-content')&&n.textContent)out.push(['text',n._markdownSource??n.textContent]);else if(n.matches('.thinking-block'))out.push(['thinking',n._reasoning??n.querySelector('.thinking-content')?.textContent]);else if(n.matches('.tool-steps'))for(const b of n.querySelectorAll('.tool-block'))out.push(['tool',b.dataset.toolId]);}return out;}
module.exports={create,flatten,functions,root};
