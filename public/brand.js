// brand mark: swap the lead glyph for the shipped svg (themed via --amber)
(function(){
var n=0, SVG='<svg viewBox="0 0 64 64" style="width:1em;height:1em;vertical-align:-0.12em" aria-hidden="true"><rect x="8" y="10" width="48" height="44" rx="8" fill="none" stroke="var(--amber,#ffa028)" stroke-width="6"/><path fill="var(--amber,#ffa028)" d="M27 24l14 8-14 8z"/></svg>';
function run(){
  document.querySelectorAll('.fhead').forEach(function(h){
    if (h.dataset.bmarked) return;
    var before = h.innerHTML, after = before;
    n++;
    var tagged = SVG.split('UID').join('bm'+n);
    after = before.replace('>▶<', '>'+tagged+'<');
    if (after === before) after = before.replace(/^(\s*)▶/, function(m,p){ return p+tagged; });
    if (after !== before) { h.innerHTML = after; h.dataset.bmarked = '1'; }
  });
}
function boot(){ run(); new MutationObserver(run).observe(document.body,{childList:true,subtree:true}); }
if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
