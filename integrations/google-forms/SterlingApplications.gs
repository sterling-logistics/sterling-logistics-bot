/* Sterling Logistics Google Forms -> Discord/Bot bridge
 *
 * Use this as a FORM-BOUND Apps Script (open the Google Form -> Extensions -> Apps Script).
 * 1) Set WEBHOOK_SECRET below to the same value as GOOGLE_FORM_WEBHOOK_SECRET in Apollo .env.
 * 2) Run installSterlingApplicationTrigger() once and approve permissions.
 * 3) Submit one test application.
 */

const STERLING_APPLICATION_ENDPOINT = 'http://45.43.163.175:8101/api/recruitment/google-form';
const WEBHOOK_SECRET = 'REPLACE_WITH_THE_SAME_SECRET_FROM_APOLLO_ENV';

function installSterlingApplicationTrigger() {
  const form = FormApp.getActiveForm();
  if (!form) throw new Error('Open this script from the Sterling Logistics Google Form.');

  // Avoid duplicate triggers if setup is run more than once.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendSterlingApplication')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('sendSterlingApplication')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('Sterling application webhook trigger installed.');
}

function sendSterlingApplication(e) {
  if (!e || !e.response) throw new Error('This function must run from the Google Form submit trigger.');
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.indexOf('REPLACE_') === 0) {
    throw new Error('Set WEBHOOK_SECRET before using the integration.');
  }

  const answers = {};
  e.response.getItemResponses().forEach(r => {
    const title = r.getItem().getTitle();
    const value = r.getResponse();
    answers[title] = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
  });

  const payload = JSON.stringify({
    submittedAt: new Date().toISOString(),
    formId: e.source ? e.source.getId() : null,
    responseId: e.response.getId ? e.response.getId() : null,
    answers: answers
  });

  const response = UrlFetchApp.fetch(STERLING_APPLICATION_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    headers: {
      'X-Sterling-Form-Secret': WEBHOOK_SECRET
    },
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  console.log('Sterling webhook response ' + status + ': ' + body);

  if (status < 200 || status >= 300) {
    throw new Error('Sterling application webhook failed (' + status + '): ' + body);
  }
}

function testSterlingWebhookConnection() {
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.indexOf('REPLACE_') === 0) {
    throw new Error('Set WEBHOOK_SECRET first.');
  }

  const response = UrlFetchApp.fetch(STERLING_APPLICATION_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({answers:{'Discord username':'TEST-NOT-A-REAL-APPLICATION'}}),
    headers: {'X-Sterling-Form-Secret': WEBHOOK_SECRET},
    muteHttpExceptions: true
  });

  Logger.log('HTTP ' + response.getResponseCode());
  Logger.log(response.getContentText());
}
