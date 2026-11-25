import { CopilotBrowser } from './browser.js';
import { ensureCopiDirs, getCopiPaths } from './paths.js';

const paths = await ensureCopiDirs(getCopiPaths());
const browser = new CopilotBrowser({
  profileDir: paths.sharedProfileDir,
  diagnosticPath: paths.inputDiagnosticFile
});
let lastText = '', previewActive = false;
const report = text => {
  if (previewActive && !lastText.endsWith('\n')) process.stdout.write('\n');
  previewActive = false;
  console.log(text);
};

try {
  if (process.argv.length > 2) {
    throw new Error('This command only checks browser connectivity. Use copi to open the coding agent.');
  }
  await browser.ask('Reply exactly: Browser connection successful.', {
    onStatus: report,
    onSnapshot: ({ text }) => {
      const append = text.startsWith(lastText);
      if (!lastText) report('Reply preview:');
      else if (!append) report('[The webpage revised the reply; replacing the preview]');
      else if (!previewActive) report('[Continuing]');
      process.stdout.write(append ? text.slice(lastText.length) : text);
      lastText = text;
      previewActive = true;
    }
  });
  report('Reply complete. Close the Edge window to finish this check.');
} catch (error) {
  console.error('\nBrowser check failed:', error.message);
  if (browser.context) console.error('Inspect the webpage, then close Edge to finish this check.');
  process.exitCode = 1;
} finally {
  await browser.closed;
  await browser.close();
}
