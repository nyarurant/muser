// Probe: the onboarding text prompt alone, after the same screen clear muser does.
process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
const p = require('@clack/prompts');
(async () => { const v = await p.text({message: 'メール', placeholder: 'you@example.com'}); console.log('VALUE=' + JSON.stringify(v)); process.exit(0); })();
