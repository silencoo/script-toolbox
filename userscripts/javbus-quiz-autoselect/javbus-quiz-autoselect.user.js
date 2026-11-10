// ==UserScript==
// @name         JavBus 驾考题自动勾选
// @namespace    local-driving-quiz
// @version      1.0.1
// @description  按题干和选项文字匹配已核对的驾考题并勾选答案
// @match        https://www.javbus.com/doc/driver-verify*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  if (!/^\/doc\/driver-verify(?:\.php)?$/.test(location.pathname)) return;

  // 题库中的答案保存为选项文本，选项顺序变化时仍能匹配。
  const bank = [
    {"question":"在考试过程中有贿赂.舞弊行为的，申请人在多少年内不得再次申领机动车驾驶证？","options":["1年","4年","2年","3年"],"answer":"1年"},
    {"question":"机动车驾驶人请他人代为接受交通违法行为处罚和记分并支付经济利益的，由公安机关交通管理部门处所支付经济利益多少倍以下罚款，但最高不得超过多少万元？","options":["两，两","三，三","两，五","三，五"],"answer":"三，五"},
    {"question":"驾驶机动车发生交通事故后当事人故意破坏、伪造现场、毁灭证据的，应承担什么责任？","options":["全部责任","同等责任","次要责任","主要责任"],"answer":"全部责任"},
    {"question":"当事人有以下哪种行为，要承担交通事故全部责任？","options":["在快车道与摩托车刮碰的","在高速公路上撞伤行人的","发生事故后故意损坏、伪造现场、毁灭证据的","在路口直行与转弯车辆刮碰的"],"answer":"发生事故后故意损坏、伪造现场、毁灭证据的"},
    {"question":"机动车驾驶人逾期不参加审验仍然驾驶机动车的，会受到什么处罚？","options":["200元以上500元以下","1000元以上2000以下","20元以上200元以下","吊销驾驶证"],"answer":"200元以上500元以下"},
    {"question":"机动车驾驶人在驾驶证有效期满前多长时间申请换证？","options":["30日内","6个月内","90日内","60日内"],"answer":"90日内"},
    {"question":"驾驶机动车行经人行横道，不按规定减速.停车.避让行人，一次记多少分？","options":["12分","6分","3分","1分"],"answer":"3分"},
    {"question":"造成致人轻伤以上或者死亡的交通事故后逃逸，尚不构成犯罪的，一次记几分？","options":["6分","12分","3分","1分"],"answer":"12分"},
    {"question":"超过机动车驾驶证有效期一年以上未换证被注销，但未超过二年的，机动车驾驶人应当如何恢复驾驶资格？","options":["参加道路驾驶技能考试合格后","参加道路交通安全法律、法规和相关知识考试合格后","参加场地考试合格后","参加安全文明驾驶常识考试合格后"],"answer":"参加道路交通安全法律、法规和相关知识考试合格后"},
    {"question":"隐瞒有关情况或提供虚假材料申请机动车驾驶证，申请人在多少年内不得再次申领机动车驾驶证？","options":["3年","1年","4年","2年"],"answer":"1年"},
    {"question":"驾驶机动车在高速公路或城市快速路上不按规定车道行驶的，一次记几分？","options":["9分","6分","1分","3分"],"answer":"3分"},
    {"question":"年龄在70周岁以上的驾驶人多长时间要提交一次身体条件证明？","options":["每6个月","每1年","每3年","每2年"],"answer":"每1年"},
    {"question":"申请人存在以下哪种行为，在一年内不得再次申领机动车驾驶证？","options":["不能按照教学大纲认真练习驾驶技能","在考试过程中有舞弊行为","未参加理论培训","在考试过程中出现身体不适"],"answer":"在考试过程中有舞弊行为"},
    {"question":"机动车驾驶人户籍迁出原车辆管理所需要向什么地方的车辆管理所提出申请？","options":["居住地","所在地","迁出地","迁入地"],"answer":"迁入地"},
    {"question":"机动车驾驶证记载的驾驶人信息发生变化的要在多长时间内申请换证？","options":["50日","40日","30日","60日"],"answer":"30日"},
    // 以 JavBus 对这道题实际接受的选项为准。
    {"question":"申请轻型牵引挂车准驾车型的，年龄不得超过多少岁？","options":["70周岁","65周岁","60周岁","55周岁"],"answer":"60周岁"},
    {"question":"驾驶机动车在高速公路上倒车的，一次记几分？","options":["1分","12分","6分","3分"],"answer":"12分"},
    {"question":"机动车购买后尚未注册登记，需要临时上道路行驶的，应当凭什么临时上道路行驶？","options":["临时行驶车号牌","借用的机动车号牌","合法来源凭证","法人单位证明"],"answer":"临时行驶车号牌"},
    {"question":"实习期内驾驶人驾驶机动车上高速公路行驶，以下做法正确的是什么？","options":["任何情况下都不允许上高速","不需要其他人员陪同","需要持有相应或者更高准驾车型驾驶证三年以上的驾驶人陪同","需要持有相应或者更高准驾车型驾驶证、同在实习期内的驾驶人陪同"],"answer":"需要持有相应或者更高准驾车型驾驶证三年以上的驾驶人陪同"},
    {"question":"初次申领机动车驾驶证的，可以申请以下哪种准驾车型？","options":["普通三轮摩托车","大型客车","中型客车","重型牵引挂车"],"answer":"普通三轮摩托车"}
  ];

  function normalize(text) {
    return text.normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/(?<=[\u3400-\u9fff])[,.、](?=[\u3400-\u9fff])/g, '')
      .replace(/[.。?!；;]+$/, '');
  }

  function questionKey(question, options) {
    return JSON.stringify([normalize(question), options.map(normalize).sort()]);
  }

  const answers = new Map(bank.map(row => [
    questionKey(row.question, row.options),
    normalize(row.answer),
  ]));
  const selector = 'input[type="radio"][name^="userAnswers["]';
  const form = [...document.forms].find(candidate => candidate.querySelector(selector));
  if (!form) return;

  let selected = 0;
  let unmatched = 0;
  let alreadyChecked = 0;

  for (const label of form.querySelectorAll('li > label')) {
    const radios = [...label.querySelectorAll(selector)];
    if (radios.length !== 4) continue;
    if (radios.some(radio => radio.checked)) {
      alreadyChecked++;
      continue;
    }

    const lines = label.innerText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const firstChoice = lines.findIndex(line => /^[A-D][.．、]\s*/.test(line));
    const parsed = lines.slice(firstChoice).map(line => line.match(/^([A-D])[.．、]\s*(.+)$/));
    if (firstChoice < 1 || parsed.length !== 4 || parsed.some(choice => !choice)) {
      unmatched++;
      continue;
    }

    const options = new Map(parsed.map(([, letter, content]) => [letter, content]));
    if (options.size !== 4 || radios.some(radio => !options.has(radio.value))) {
      unmatched++;
      continue;
    }

    const question = lines.slice(0, firstChoice).join(' ');
    const correct = answers.get(questionKey(question, [...options.values()]));
    const matches = radios.filter(radio => normalize(options.get(radio.value)) === correct);
    if (matches.length !== 1 || matches[0].matches(':disabled')) {
      unmatched++;
      continue;
    }

    matches[0].checked = true;
    selected++;
  }

  console.info('[驾考题自动勾选]', { selected, unmatched, alreadyChecked });
})();
