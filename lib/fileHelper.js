const fs = require('fs').promises;
const { times } = require('lodash');
const path = require('path');

module.exports.getNewFileName = function (fileName) {
  const chunks = fileName.split('.');
  if (chunks.length > 1) {
    const ext = `.${chunks[chunks.length - 1]}`;
    return chunks.slice(0, chunks.length - 1).join('.') + ' (' + Date.now() + ')' + ext;
  }
  return fileName + ' (' + Date.now() + ')';
};

module.exports.saveFile = async function (fileName, content, timestampMs) {
  try {
    // Write the file
    await fs.writeFile(fileName, content);

    // Convert timestampMs to a number (integer)
    const parsedTimestamp = parseInt(timestampMs, 10);

    if (!isNaN(parsedTimestamp)) {
      // Create Date objects for atime (current time) and mtime
      const accessedDate = new Date();
      const modifiedDate = new Date(parsedTimestamp + (new Date().getTimezoneOffset() * 60000));

      // Update the file's access and modified timestamps
      await fs.utimes(fileName, accessedDate, modifiedDate);

      console.log(`${fileName} file was saved with modified date!`);
    } else {
      console.error("Invalid timestamp: ", timestampMs);
    }
  } catch (error) {
    console.error(`Failed to save file: ${error.message}`);
  }
};

module.exports.isFileExist = async function (fileName) {
  try {
    await fs.access(fileName);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    } else {
      throw error;
    }
  }
};

module.exports.getParentDir = function (argv, baseDir, time) {
  const date = new Date(Number(time));
  let dirPath = path.resolve(baseDir, 'files');
  if (argv.from) {
    dirPath = path.resolve(baseDir, 'files', argv.from);
  }
  if (argv.fy) {
    dirPath = path.resolve(dirPath, String(date.getFullYear()));
  }
  return dirPath;
};
