# JavBus Driving Quiz Auto-Select

A standalone Tampermonkey userscript that selects known answers on the JavBus
driving quiz page. It matches the question and all four option texts, so the
order of the options can change.

## Install

1. In Tampermonkey, choose **Create a new script**.
2. Replace the template with the contents of
   [javbus-quiz-autoselect.user.js](./javbus-quiz-autoselect.user.js), then save.
3. Open or reload the JavBus driving quiz page. Review the selected answers and
   submit the form yourself.

The script leaves unfamiliar questions blank and preserves any choice already
selected. Its answer bank reflects the site's quiz. For the light trailer
licence question, it selects `60周岁` because JavBus accepted that choice.

## Check

From the repository root:

```sh
node --check userscripts/javbus-quiz-autoselect/javbus-quiz-autoselect.user.js
```
