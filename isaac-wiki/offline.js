'use strict';
// Expand static tab panels without depending on the live Wiki's JavaScript runtime.
document.querySelectorAll('.tabbertab').forEach(panel=>{panel.style.display='block';const title=panel.getAttribute('title');if(title){const heading=document.createElement('h3');heading.textContent=title;heading.className='offline-tabs';panel.prepend(heading);}});
document.querySelectorAll('.mw-collapsible-content').forEach(panel=>panel.style.display='block');
document.querySelectorAll('.html_recentchange').forEach(panel=>panel.textContent='实时编辑记录需要联网查看原站。');
document.querySelectorAll('div').forEach(panel=>{if(panel.children.length===0&&/^(动画拼命加载中|换装中)$/.test(panel.textContent.trim()))panel.textContent='动画预览需要原站播放器。';});
