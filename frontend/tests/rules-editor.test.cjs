const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {section}=require('./helpers.cjs');

function editor(rules) {
  const saves=[];
  const draft={arm:'always',rules:structuredClone(rules)};
  const ctx=vm.createContext({P2:{name:'saved_rules',draft},S:{vocab:{
    rule_triggers:{fields:{wave_at_least:{fields:{}}}},
    rule_actions:{fields:{cancel_sprint:{fields:{}},toggle_uw:{fields:{weapon:{type:'string',values:['chain_lightning','poison_swamp']},want_on:{type:'bool'}}}}}
  }},esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    p2Save:()=>saves.push(structuredClone(draft))});
  vm.runInContext(section('function pInput(', 'function shopHtml(){'),ctx);
  return {ctx,draft,saves,render:()=>ctx.rescueHtml()};
}

const activeRule=()=>({when:{wave_at_least:500},do:{toggle_uw:{weapon:'chain_lightning',want_on:true}}});

test('old source rules render ignored without fallback editors, preserving mixed rule data and indices',()=>{
  const rules=[
    {when:{death_screen:true},do:{cancel_sprint:true},note:'<saved source>'},
    {when:{wave_at_least:1000},do:{stop_after_run:true}},
    activeRule()
  ];
  const page=editor(rules),html=page.render();
  assert.deepEqual(page.draft.rules,rules);
  assert.deepEqual(page.saves,[]);
  const cards=html.split('<div class="rulecard">').slice(1);
  assert.equal(cards.length,3);
  for (const [index,card] of cards.slice(0,2).entries()) {
    assert.match(card,/Retired rule — ignored/);
    assert.match(card,new RegExp(`p2delRule\\(${index}\\)"`));
    assert.match(card,/Delete retired rule/);
    assert.doesNotMatch(card,/<select|<input|p2trig|p2act|p2rule\(/);
  }
  assert.match(cards[0],/death_screen/);
  assert.match(cards[0],/&lt;saved source&gt;/);
  assert.doesNotMatch(cards[0],/<saved source>/);
  assert.match(cards[1],/stop_after_run/);
  assert.match(cards[2],/p2trigKind\(2, this.value\)/);
  assert.match(cards[2],/p2actKind\(2, this.value\)/);
  assert.match(cards[2],/value="toggle_uw" selected/);
  assert.match(cards[2],/chain_lightning/);
  assert.doesNotMatch(cards[2],/Retired rule/);
});

test('editing an active rule and explicitly deleting a retired rule affect their original indices only',()=>{
  const retired={when:{death_screen:true},do:{stop_after_run:true}};
  const page=editor([retired,activeRule()]);
  page.render();
  page.ctx.p2act(1,'weapon','poison_swamp');
  assert.deepEqual(page.draft.rules[0],retired);
  assert.deepEqual(JSON.parse(JSON.stringify(page.draft.rules[1])),{
    when:{wave_at_least:500},do:{toggle_uw:{weapon:'poison_swamp',want_on:true}}
  });
  page.ctx.p2delRule(0);
  assert.equal(page.draft.rules.length,1);
  assert.equal(page.draft.rules[0].do.toggle_uw.weapon,'poison_swamp');
  assert.equal(page.saves.length,2);
  assert.match(page.render(),/p2actKind\(0, this.value\)/);
});

test('retired keys are ignored by presence even when their saved flag is false',()=>{
  const rules=[{when:{death_screen:false},do:{cancel_sprint:true}},
    {when:{wave_at_least:1},do:{stop_after_run:false}}];
  const page=editor(rules),html=page.render();
  assert.equal((html.match(/Retired rule — ignored/g)||[]).length,2);
  assert.doesNotMatch(html,/p2trigKind|p2actKind/);
  assert.deepEqual(page.draft.rules,rules);
});
