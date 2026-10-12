import { PayPalCredentialStore, PAYPAL_CREDENTIAL_DIRECTORY } from '../src/paypal-credentials.js';

// No keys may be supplied as command-line arguments or environment variables
// to this importer. --stdin accepts one bounded JSON object through a private
// pipe; the default uses hidden terminal entry for both values.
async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Use a terminal for hidden entry, or --stdin with a private JSON pipe.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = ''; let finished = false;
    const finish = (error = null) => {
      if (finished) return; finished = true;
      process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') return finish(Error('Setup cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue; }
        if (!/^[A-Za-z0-9_-]$/.test(character) || value.length >= 512) return finish(Error('Invalid credential entry.'));
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function stdinCredentials() {
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length; if (bytes > 1600) throw Error('Credential input exceeded its limit.'); chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

try {
  if (process.argv.slice(2).some(argument => argument !== '--stdin') || process.argv.length > 3) throw Error('Unsupported setup arguments.');
  const credentials = process.argv[2] === '--stdin' ? await stdinCredentials() : {
    clientId: await hiddenQuestion('PayPal SANDBOX client ID (hidden): '),
    secret: await hiddenQuestion('PayPal SANDBOX secret (hidden): '),
  };
  await new PayPalCredentialStore().write(credentials);
  console.log(`PayPal sandbox credentials saved locally to ${PAYPAL_CREDENTIAL_DIRECTORY}.`);
  console.log('No PayPal authentication or invoice request was made. Restart ScopeGuard after removing any old PayPal environment overrides.');
} catch {
  // Raw parse/process/storage errors may include credential content. Never log
  // them, stdin or helper diagnostics; this message contains no input values.
  console.error('PayPal setup did not finish. Use hidden terminal entry or --stdin with one private JSON object containing clientId and secret; check the dedicated storage permissions.');
  process.exitCode = 1;
}
