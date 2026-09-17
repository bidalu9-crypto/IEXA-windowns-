/* Shared by the renderer and server: deterministic line diff and per-turn grouping. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IexaFileChanges=api;})(typeof window!=='undefined'?window:globalThis,function(){
  function lines(text){return text===''?[]:String(text).split(/\r?\n/).filter((_,i,a)=>i<a.length-1||a[i]!=='');}
  function diff(before,after){
    const a=lines(before),b=lines(after);let prefix=0,suffix=0;
    while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
    while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix);
    let middle=[],exact=true;
    if(x.length*y.length<=1000000){
      const cols=y.length+1,dp=new Uint32Array((x.length+1)*cols);
      for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)dp[i*cols+j]=x[i]===y[j]?1+dp[(i+1)*cols+j+1]:Math.max(dp[(i+1)*cols+j],dp[i*cols+j+1]);
      let i=0,j=0;
      while(i<x.length||j<y.length){
        if(i<x.length&&j<y.length&&x[i]===y[j]){middle.push({type:'context',text:x[i++]});j++;}
        else if(i<x.length&&(j===y.length||dp[(i+1)*cols+j]>=dp[i*cols+j+1]))middle.push({type:'removed',text:x[i++]});
        else middle.push({type:'added',text:y[j++]});
      }
    }else{
      // Myers handles widely separated edits without allocating a quadratic matrix.
      const frontier=new Map([[1,0]]),trace=[];let found=false,work=0;
      search: for(let d=0;d<=x.length+y.length&&d<=1400;d++){
        trace.push(new Map(frontier));
        for(let k=-d;k<=d;k+=2){
          if(++work>2000000)break search;
          let i=k===-d||(k!==d&&(frontier.get(k-1)??-1)<(frontier.get(k+1)??-1))?(frontier.get(k+1)||0):(frontier.get(k-1)||0)+1;
          let j=i-k;
          while(i<x.length&&j<y.length&&x[i]===y[j]){i++;j++;if(++work>2000000)break search;}
          frontier.set(k,i);
          if(i>=x.length&&j>=y.length){
            found=true;
            for(let depth=d;depth>=0;depth--){
              const v=trace[depth],diagonal=i-j;
              const previous=diagonal===-depth||(diagonal!==depth&&(v.get(diagonal-1)??-1)<(v.get(diagonal+1)??-1))?diagonal+1:diagonal-1;
              const oldI=v.get(previous)||0,oldJ=oldI-previous;
              while(i>oldI&&j>oldJ){middle.push({type:'context',text:x[--i]});j--;}
              if(depth===0)break;
              if(i===oldI)middle.push({type:'added',text:y[--j]});else middle.push({type:'removed',text:x[--i]});
            }
            middle.reverse();break search;
          }
        }
      }
      if(!found){exact=false;middle=x.map(text=>({type:'removed',text})).concat(y.map(text=>({type:'added',text})));}
    }
    const ops=a.slice(0,prefix).map(text=>({type:'context',text})).concat(middle,a.slice(a.length-suffix).map(text=>({type:'context',text})));
    return {ops,added:middle.filter(x=>x.type==='added').length,removed:middle.filter(x=>x.type==='removed').length,exact};
  }
  function group(changes){
    const byPath=new Map();
    for(const change of changes||[]){
      if(!change?.path)continue;
      const key=String(change.absolutePath||change.path).replace(/\\/g,'/');
      const canonical=/^[A-Za-z]:\//.test(key)?key.toLowerCase():key;
      const previous=byPath.get(canonical);
      if(previous){previous.after=change.after;previous.previewTruncated=previous.previewTruncated||change.previewTruncated;previous.records.push(change);previous.added+=Number(change.added)||0;previous.removed+=Number(change.removed)||0;}
      else byPath.set(canonical,{...change,records:[change]});
    }
    return [...byPath.values()].map(file=>{
      if(typeof file.before==='string'&&typeof file.after==='string'&&!file.previewTruncated){const d=diff(file.before,file.after);file.added=d.added;file.removed=d.removed;file.exact=d.exact;}
      else file.exact=false;
      return file;
    });
  }
  return {diff,group};
});
