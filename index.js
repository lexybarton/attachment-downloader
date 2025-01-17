const _ = require('lodash');
const atob = require('atob');
const fs = require('fs');
const moment = require('moment');
const inquirer = require('inquirer');
const path = require('path');
const ora = require('ora');

const AuthFetcher = require('./lib/googleAPIWrapper');
const FileHelper = require('./lib/fileHelper');
const { time } = require('console');
let pageCounter = 1;

let messageIds = [];
let gmail;
String.prototype.replaceAll = function (search, replacement) {
  var target = this;
  return target.split(search).join(replacement);
}

const spinner = ora('Reading 1 page');
AuthFetcher.getAuthAndGmail(main);

/**
 * Lists the labels in the user's account.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
function listLabels(auth, gmail) {
  return new Promise((resolve, reject) => {
    gmail.users.labels.list({
      auth: auth,
      userId: 'me',
    }, (err, response) => {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      resolve(response);
    });
  })
}

function main(auth, gmailInstance) {
  let labels;
  let coredata = {};
  let workflow;
  gmail = gmailInstance;
  if (detectCommandOptions()) {
    workflow = scanForLabelOption;
  } else {
    workflow = defaultBehaviour;
  }
  workflow(auth, gmail, coredata)
    .then((mailList) => {
      coredata.mailList = mailList;
      return fetchMailsByMailIds(auth, mailList);
    })
    .then((mails) => {

      coredata.attachments = pluckAllAttachments(mails);
      return fetchAndSaveAttachments(auth, coredata.attachments);
    })
    .then(() => {
      spinner.stop()
      console.log('Done');
    })
    .catch((e) => console.log(e));
}

const detectCommandOptions = () => process.argv.length > 2;

const defaultBehaviour = (auth, gmail, coredata) => {
  return askForFilter()
    .then((option) => {
      if (option === 'label') {
        return listLabels(auth, gmail)
          .then((response) => {
            labels = response.data.labels;
            return labels;
          })
          .then(askForLabel)
          .then((selectedLabel) => {
            coredata.label = selectedLabel;
            spinner.start()
            return getListOfMailIdByLabel(auth, coredata.label.id, 200);
          });
      } else if (option === 'from') {
        return askForMail()
          .then((mailId) => {
            spinner.start()
            return getListOfMailIdByFromId(auth, mailId, 50);
          });
      } else {
        spinner.start()
        return getAllMails(auth, 500)
      }
    });
};

const scanForLabelOption = (auth, gmail) => {
  return new Promise((resolve, reject) => {
    const paramsNumber = process.argv.length;
    if (paramsNumber == 4) {
      const optionName = process.argv[2];
      if (optionName === '--label') {
        resolve(process.argv[3]);
      }
    }
    reject("WARNING: expected --label LABEL_NAME option")
  })
    .then(labelName => {
      return listLabels(auth, gmail)
        .then(response => {
          const labelObj = _.find(response.data.labels, l => l.name === labelName);
          return getListOfMailIdByLabel(auth, labelObj.id, 200);
        });
    });
};

async function fetchAndSaveAttachments(auth, attachments) {
  let results = [];
  let promises = [];
  let counter = 0;
  let processed = 0;
  spinner.text = "Fetching attachment from mails"

  // Group attachments by mailId
  const attachmentsGroupedByMailId = _.groupBy(attachments, 'mailId');

  for (const mailId in attachmentsGroupedByMailId) {
    const attachmentsForMail = attachmentsGroupedByMailId[mailId];
    promises.push(fetchMessageDetailsAndSaveAttachments(auth, mailId, attachmentsForMail));
    counter++;
    processed++;
    if (counter === 100) {
      attachs = await Promise.all(promises);
      _.merge(results, attachs);
      promises = [];
      counter = 0;
      spinner.text = processed + " attachments are saved"
    }
  }

  attachs = await Promise.all(promises);
  _.merge(results, attachs);
  return results;
}

async function fetchMessageDetailsAndSaveAttachments(auth, mailId, attachments) {
  const attachmentDetailsPromises = attachments.map(async (attachment) => {
    try {
      const response = await gmail.users.messages.get({
        auth: auth,
        userId: 'me',
        id: mailId,
        format: 'minimal', // Request minimal format
      });

      // Extract timestamp and format it
      const emailTimestamp = response.data.internalDate;
      const formattedTimestamp = moment(parseInt(emailTimestamp)).format('YYYY-MM-DD_HHmmss');

      // Construct the new file name with the timestamp
      const fileName = path.resolve(__dirname, 'files', `${path.basename(attachment.name, path.extname(attachment.name))}-${formattedTimestamp}${path.extname(attachment.name)}`);

      return {
        attachment,
        fileName,
        emailTimestamp
      };
    } catch (error) {
      throw new Error(`Failed to fetch message details for attachment: ${attachment.id}`, error);
    }
  });

  const attachmentDetails = await Promise.all(attachmentDetailsPromises);

  const savePromises = attachmentDetails.map(async ({ attachment, fileName, emailTimestamp }) => {
    try {
      const data = await fetchAttachmentData(auth, attachment);
      await FileHelper.saveFile(fileName, data, emailTimestamp);
      return attachment;
    } catch (error) {
      throw new Error(`Failed to save attachment: ${attachment.id}`, error);
    }
  });

  return await Promise.all(savePromises);
}

async function fetchAttachmentData(auth, attachment) {
  const response = await gmail.users.messages.attachments.get({
    auth: auth,
    userId: 'me',
    messageId: attachment.mailId,
    id: attachment.id,
  });

  const data = response.data.data.replaceAll('-', '+').replaceAll('_', '/');
  return fixBase64(data);
}



function pluckAllAttachments(mails) {
  return _.compact(_.flatten(_.map(mails, (m) => {
    if (!m.data || !m.data.payload || !m.data.payload.parts) {
      return undefined;
    }
    if (m.data.payload.mimeType === "multipart/signed") {
      return _.flatten(_.map(m.data.payload.parts, (p) => {
        if (p.mimeType !== "multipart/mixed") {
          return undefined;
        }
        return _.map(p.parts, (pp) => {
          if (!pp.body || !pp.body.attachmentId) {
            return undefined;
          }
          const attachment = {
            mailId: m.data.id,
            name: pp.filename,
            id: pp.body.attachmentId
          };
          return attachment;
        })
      }))
    } else {
      return _.map(m.data.payload.parts, (p) => {
        if (!p.body || !p.body.attachmentId) {
          return undefined;
        }
        const attachment = {
          mailId: m.data.id,
          name: p.filename,
          id: p.body.attachmentId
        };
        return attachment;
      })
  }
  })));
}

function askForLabel(labels) {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'label',
      message: 'Choose label for filter mails:',
      choices: _.map(labels, 'name'),
      filter: val => _.find(labels, l => l.name === val)
    }
  ])
    .then(answers => answers.label);
}

function askForFilter(labels) {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'option',
      message: 'How do you like to filter',
      choices: ['Using from email Id', 'Using label', "All"],
      filter: val => {
        if (val === 'Using from email Id') {
          return 'from';
        } else if (val === 'Using label') {
          return 'label';
        } else {
          return 'all'
        }
      }
    }
  ])
    .then(answers => answers.option);
}

function askForMail() {
  return inquirer.prompt([
    {
      type: 'input',
      name: 'from',
      message: 'Enter from mailId:'
    }
  ])
    .then(answers => answers.from);
}

function getListOfMailIdByLabel(auth, labelId, maxResults = 500, nextPageToken) {
  return new Promise((resolve, reject) => {


    gmail.users.messages.list({
      auth: auth,
      userId: 'me',
      labelIds: labelId,
      maxResults: maxResults,
      pageToken: nextPageToken ? nextPageToken : undefined
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      if (response.data) {
        messageIds = messageIds.concat(response.data.messages)
        if (response.data.nextPageToken) {
          spinner.text = "Reading page: " + ++pageCounter
          resolve(getListOfMailIdByLabel(auth, labelId, maxResults, response.data.nextPageToken))
        }
      }
      spinner.text = "All pages are read"
      resolve(messageIds)
    });
  });
}

function getAllMails(auth, maxResults = 500, nextPageToken) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.list({
      auth: auth,
      userId: 'me',
      maxResults: maxResults,
      pageToken: nextPageToken ? nextPageToken : undefined
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      if (response.data) {
        messageIds = messageIds.concat(response.data.messages)
        if (response.data.nextPageToken) {
          spinner.text = "Reading page: " + ++pageCounter
          resolve(getAllMails(auth, maxResults, response.data.nextPageToken))
        }
      }
      spinner.text = "All pages are read"
      resolve(messageIds)
    });
  });
}

function getListOfMailIdByFromId(auth, mailId, maxResults = 500) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.list({
      auth: auth,
      userId: 'me',
      q: 'from:' + mailId,
      maxResults: maxResults
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      resolve(response.data.messages);
    });
  });
}

async function fetchMailsByMailIds(auth, mailList) {
  let results = [];
  let promises = [];
  let counter = 0;
  let processed = 0;
  spinner.text = "Fetching each mail"
  for (index in mailList) {
    if (mailList[index]) {
      promises.push(getMail(auth, mailList[index].id));
      counter++;
      processed++;
      if (counter === 100) {
        mails = await Promise.all(promises);
        results = results.concat(mails)
        promises = [];
        counter = 0;
        spinner.text = processed + " mails fetched"
        await sleep(3000)
      }
    }
  };
  mails = await Promise.all(promises);
  results = results.concat(mails)
  return results;
}

function sleep(ms) {
  spinner.text = `sleeping for ${ms/1000} s`
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMail(auth, mailId) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.get({
      userId: 'me',
      id: mailId,
      auth,
    }, (err, response) => {
      if (err) {
        reject(err);
      }
      resolve(response);
    })
  })
}

function fixBase64(binaryData) {
  const base64str = binaryData// base64 string from  thr response of server
  const binary = atob(base64str.replace(/\s/g, ''));// decode base64 string, remove space for IE compatibility
  const len = binary.length;         // get binary length
  const buffer = new ArrayBuffer(len);         // create ArrayBuffer with binary length
  const view = new Uint8Array(buffer);         // create 8-bit Array

  // save unicode of binary data into 8-bit Array
  for (let i = 0; i < len; i++) {
    view[i] = binary.charCodeAt(i);
  }

  return view;
}
