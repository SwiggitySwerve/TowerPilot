/* Read-only, bounded JSONL diagnostics. Filter drafts never change during refresh. */
(function(root,factory) {
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.DiagnosticsView=api;
})(typeof globalThis==='object'?globalThis:this,function() {
  'use strict';
  const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const exactFields=['instance','operation_id','battle_id','command_id','trace_id','request_id','attempt_id','window_id','offer_id','kind'];
  const titles={instance:'Instance',operation_id:'Operation ID',battle_id:'Battle ID',command_id:'Command ID',trace_id:'Trace ID',request_id:'Request ID',attempt_id:'Attempt ID',window_id:'Window ID',offer_id:'Offer ID',kind:'Event kind'};
  const numeric=value=>typeof value==='number' && Number.isFinite(value);
  function localInput(epoch) {
    if(!numeric(epoch) || epoch<0)return '';
    const date=new Date(epoch*1000);
    if(!Number.isFinite(date.getTime()))return '';
    const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
    return Number.isFinite(local.getTime())?local.toISOString().slice(0,16):'';
  }
  function fromHash(hash) {
    const values=new URLSearchParams(String(hash || '').split('?')[1] || '');
    const result={};
    for(const key of [...exactFields,'since','limit','failures'])if(values.has(key))result[key]=values.get(key);
    return result;
  }
  function query(filters) {
    const params=new URLSearchParams();
    for(const key of exactFields)if(filters[key]!==undefined && String(filters[key]).trim())params.set(key,String(filters[key]).trim());
    const limit=Number(filters.limit ?? 250);
    if(!Number.isInteger(limit) || limit<1 || limit>1000)throw Error('Limit must be an integer from 1 to 1000.');
    params.set('limit',String(limit));
    if(filters.since!==undefined && filters.since!=='') {
      const since=Number(filters.since);
      if(!Number.isFinite(since) || since<0 || !Number.isFinite(new Date(since*1000).getTime()))throw Error('Choose a valid local start time.');
      params.set('since',String(since));
    }
    params.set('failures',filters.failures===true || filters.failures==='1'?'1':'0');
    return params.toString();
  }
  function coverageText(coverage={}) {
    const count=key=>numeric(coverage[key])?coverage[key]:'unknown';
    return `Bounded scan: ${count('files_scanned')} files, ${count('bytes_read')} bytes; ${count('matched_in_scan')} matches in scanned records, ${count('returned')} returned. `+
      `Truncated: ${coverage.truncated===true?'yes':coverage.truncated===false?'no':'unknown'}. Malformed records: ${count('malformed_records')}. Read errors: ${Array.isArray(coverage.errors)?coverage.errors.length:'unknown'}. `+
      `Scan bounds: ${count('max_files')} files / ${count('max_bytes')} bytes. Results cover only the records scanned.`;
  }
  function writerHealthText(health) {
    if(!health || !numeric(health.write_errors))return 'Dashboard writer health unavailable. This view does not report other processes’ writer health.';
    const error=health.last_error;
    return `Current dashboard process (PID ${health.pid ?? 'unknown'}): ${health.write_errors} diagnostic write errors reported. `+
      (error?`Latest: ${error.exception_type || 'Error'}: ${error.message || 'details unavailable'}${numeric(error.t)?` at ${new Date(error.t*1000).toLocaleString()}`:''}. `:'')+
      'Other processes’ writers are not covered by this health snapshot.';
  }
  function runtimeHTML(result) {
    const server=result.server || {}, scan=result.process_refresh || {};
    const revision=build=>build?.source_revision?.slice(0,12) || 'unavailable (packaged or unversioned source)';
    const provenance=build=>build?.source_fingerprint?`source ${build.source_fingerprint.slice(0,12)}`:'source identity unknown';
    const changed=server.source_changed===true?'Source changed since server load; restart the dashboard to load backend changes.':
      server.source_changed===false?'Server source snapshot matches disk.':'Source freshness unknown.';
    const workers=(result.workers || []).map(op=>{
      const build=op.worker?.build;
      const matches=build?.source_fingerprint && result.server?.disk_source_fingerprint?
        build.source_fingerprint===result.server.disk_source_fingerprint?'matches current source':'source differs from disk':'source freshness unknown';
      return `<li>${esc(op.kind)} · ${esc(op.instance)} · PID ${esc(op.worker?.pid ?? 'unknown')} · ${op.alive?'running':'not verified alive'} · ${esc(revision(build))} · ${esc(provenance(build))} · ${esc(matches)}</li>`;
    }).join('');
    return `<strong>Server and workers</strong><p>Port ${esc(result.port)} · PID ${esc(server.pid)} · revision ${esc(revision(server))} · ${esc(provenance(server))}</p><p>${esc(changed)}${server.error?` ${esc(server.error.message)}`:''}</p><p>Source captured ${numeric(server.captured_at)?esc(new Date(server.captured_at*1000).toLocaleString()):'at an unknown time'}. This snapshot identifies source at load time; existing workers keep their own code.</p><p>Process discovery: ${esc(scan.state || 'unknown')}${numeric(scan.age_sec)?` · last success ${Math.floor(scan.age_sec)}s ago`:''}${scan.error?` · ${esc(scan.error.type)}: ${esc(scan.error.message)}`:''}</p>${workers?`<ul>${workers}</ul>`:'<p>No active operations recorded.</p>'}<details><summary>Capabilities and raw runtime identity</summary><pre>${esc(JSON.stringify(result,null,2))}</pre></details>`;
  }
  function eventKey(event,index) {return `${event._log?.file ?? ''}:${event._log?.offset ?? index}`;}
  function eventsHTML(events,opened=new Set()) {
    return events.map((event,index)=> {
      const key=eventKey(event,index),time=numeric(event.t)?new Date(event.t*1000).toLocaleString():'Time unknown';
      const outcome=event.outcome ?? event.reason ?? event.status ?? event.error ?? (event.confirmed===false?'Unconfirmed':event.confirmed===true?'Confirmed':'');
      const ids=[...exactFields.filter(key=>key!=='kind' && key!=='instance'),'claim_attempt_id','error_id'].filter(key=>event[key]!==undefined && event[key]!==null);
      return `<details class="diag-event ${event._log?.failure?'diag-failure':''}" data-event-key="${esc(key)}" ${opened.has(key)?'open':''}><summary><time>${esc(time)}</time><strong>${esc(event.kind || 'Kind unknown')}</strong><span>${esc(typeof outcome==='object'?JSON.stringify(outcome):outcome)}</span><span class="diag-identities">${ids.map(key=>`<span>${esc(titles[key] || key)}: <code>${esc(event[key])}</code></span>`).join('')}</span></summary><pre>${esc(JSON.stringify(event,null,2))}</pre></details>`;
    }).join('') || '<p class="muted">No matching events in this bounded scan.</p>';
  }
  function renderHTML(filters) {
    return `<article class="diagnostics-view"><header><strong>Raw diagnostics</strong><p>Filter exact identifiers to follow an operation, offer or claim attempt. Times use this browser's local timezone.</p></header><form data-diag-form><div class="diag-filters">${exactFields.map(key=>`<label>${titles[key]}<input type="text" data-diag-filter="${key}" value="${esc(filters[key])}" placeholder="Any" autocomplete="off"></label>`).join('')}<label>Since (local time)<input type="datetime-local" data-diag-since value="${esc(filters.since?localInput(Number(filters.since)):'')}"></label><label>Maximum returned<input type="number" data-diag-filter="limit" min="1" max="1000" step="1" value="${esc(filters.limit ?? 250)}" required></label></div><div class="diag-actions"><label><input type="checkbox" data-diag-filter="failures" ${filters.failures===true || filters.failures==='1'?'checked':''}>Failures only</label><button type="submit" class="small">Apply filters</button><button type="button" class="small ghost" data-diag-refresh>Refresh</button><label><input type="checkbox" data-diag-auto checked>Auto refresh (5s)</label><button type="button" class="small ghost" data-diag-export disabled>Export filtered JSON</button></div></form><p class="diag-status" data-diag-status role="status">Loading diagnostics…</p><p class="diag-coverage" data-diag-coverage></p><p class="diag-writer-health" data-diag-writer-health></p><details class="diag-coverage-details"><summary>Scan coverage and dashboard writer details</summary><pre data-diag-coverage-raw></pre></details><div data-diag-events></div></article>`;
  }
  function exportPayload(result,filters,now=Date.now()/1000) {
    return JSON.stringify({exported_at:now,filters,coverage:result.coverage,writer_health:result.writer_health ?? null,events:result.events},null,2);
  }
  function create(options) {
    const request=options.request, doc=options.document ?? globalThis.document;
    const setTimer=options.setInterval ?? globalThis.setInterval, clearTimer=options.clearInterval ?? globalThis.clearInterval;
    let host=null,filters={},result=null,resultFilters={},timer=null,generation=0,busy=false,queued=false,dirty=false,auto=true,sourceKey='',runtimeBusy=false;
    function visible() {return !!host?.isConnected && doc?.visibilityState!=='hidden' && !host.closest?.('[hidden]');}
    function status(text) {const el=host?.querySelector('[data-diag-status]');if(el)el.textContent=text;}
    async function refreshRuntime() {
      const target=host,token=generation,region=host?.querySelector('[data-diag-runtime]');
      if(!region || runtimeBusy || !visible())return;
      runtimeBusy=true;
      try {
        const response=await request('/api/runtime');
        if(host===target && token===generation)region.innerHTML=runtimeHTML(response);
      } catch(error) {
        if(host===target && token===generation)region.textContent=`Runtime identity unavailable: ${error.message}. Refresh to retry; older servers may not expose this endpoint.`;
      } finally {
        runtimeBusy=false;
        if(host!==target || token!==generation)refreshRuntime();
      }
    }
    function readFilters() {
      const values={};
      host.querySelectorAll('[data-diag-filter]').forEach(input=>values[input.dataset.diagFilter]=input.type==='checkbox'?input.checked:input.value);
      const since=host.querySelector('[data-diag-since]')?.value;
      values.since=since?new Date(since).getTime()/1000:'';
      query(values);
      return values;
    }
    async function refresh() {
      if(!visible())return;
      refreshRuntime();
      if(busy){queued=true;return;}
      const target=host,token=generation,applied={...filters};
      busy=true;
      status(dirty?'Filters changed; apply them to update results. Refreshing applied filters…':'Reading bounded event logs…');
      try {
        const response=await request('/api/diagnostics/events?'+query(applied));
        if(host!==target || token!==generation)return;
        if(!Array.isArray(response.events) || !response.coverage)throw Error('Diagnostics response did not include events and scan coverage.');
        result=response;
        resultFilters=applied;
        const coverage=host.querySelector('[data-diag-coverage]');if(coverage)coverage.textContent=coverageText(response.coverage);
        const health=host.querySelector('[data-diag-writer-health]');if(health)health.textContent=writerHealthText(response.writer_health);
        const raw=host.querySelector('[data-diag-coverage-raw]');if(raw)raw.textContent=JSON.stringify({coverage:response.coverage,writer_health:response.writer_health ?? null},null,2);
        const rows=host.querySelector('[data-diag-events]');
        if(rows && !rows.contains?.(doc?.activeElement)) {
          const opened=new Set(Array.from(rows.querySelectorAll('[data-event-key][open]'),el=>el.dataset.eventKey));
          const html=eventsHTML(response.events,opened);if(rows.innerHTML!==html)rows.innerHTML=html;
        }
        const button=host.querySelector('[data-diag-export]');if(button)button.disabled=false;
        status(`${dirty?'Filters changed; showing applied filters. ':''}Updated ${new Date().toLocaleTimeString()}. ${response.events.length} events returned; coverage is bounded.`);
      } catch(error) {
        if(host===target && token===generation)status(`Diagnostics unavailable: ${error.message}${result?' · previous bounded result retained':''}`);
      } finally {
        busy=false;
        if(queued){queued=false;refresh();}
      }
    }
    function download() {
      if(!result)return;
      const text=exportPayload(result,resultFilters);
      if(options.onExport){options.onExport(text);return;}
      const blob=new Blob([text],{type:'application/json'}),url=URL.createObjectURL(blob),link=doc.createElement('a');
      link.href=url;link.download=`towerpilot-diagnostics-${Date.now()}.json`;
      doc.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    function unmount() {
      if(timer!==null)clearTimer(timer);timer=null;
      if(host){host.oninput=null;host.onchange=null;host.onsubmit=null;host.onclick=null;}
      host=null;generation++;queued=false;
    }
    return {mount(target,context={}) {
      // Device context invalidates stale responses; it is not a log-source filter.
      // Dashboard requests live alongside emulator logs and must remain searchable.
      const incoming={instance:'',since:Date.now()/1000-3600,limit:250,...context.filters};
      const key=JSON.stringify([context.instance || '',context.filters || {}]);
      if(host===target && key===sourceKey)return;
      unmount();host=target;sourceKey=key;filters=incoming;result=null;dirty=false;auto=true;
      if(!host)return;
      host.innerHTML=renderHTML(filters);
      const runtime=doc?.createElement?.('section');
      if(runtime){runtime.dataset.diagRuntime='';runtime.className='diag-runtime';runtime.setAttribute('aria-live','polite');host.prepend(runtime);}
      host.oninput=event=>{if(event.target.closest('[data-diag-filter], [data-diag-since]')){dirty=true;status('Filters changed; apply them to update results.');}};
      host.onchange=event=>{if(event.target.closest('[data-diag-auto]'))auto=event.target.checked;};
      host.onsubmit=event=> {
        event.preventDefault();
        try {filters=readFilters();dirty=false;generation++;refresh();}
        catch(error){status(error.message);}
      };
      host.onclick=event=> {
        if(event.target.closest('[data-diag-refresh]'))refresh();
        else if(event.target.closest('[data-diag-export]'))download();
      };
      timer=setTimer(()=>{if(auto && visible())refresh();},5000);
      refresh();
    },unmount,refresh,destroy:unmount};
  }
  return {create,fromHash,query,coverageText,writerHealthText,runtimeHTML,eventsHTML,renderHTML,exportPayload};
});
