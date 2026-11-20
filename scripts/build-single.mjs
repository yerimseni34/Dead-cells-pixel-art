// Aracı tek bir HTML dosyasına paketler: kurulum yok, çift tıklayınca tarayıcıda açılır.
// Kullanım: npm run build:single  ->  Pixel-Sprite-Araci.html
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

execSync('npx vite build', { stdio: 'inherit' });
const assets = readdirSync('dist/assets');
const read = (ext) => readFileSync('dist/assets/' + assets.find((f) => f.endsWith(ext)), 'utf8');
const css = read('.css');
const js = read('.js').replaceAll('</script', '<\\/script');
const html = readFileSync('dist/index.html', 'utf8');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[^>]*><\/script>/g, '');

writeFileSync('Pixel-Sprite-Araci.html', `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pixel Sprite Aracı</title>
<style>${css}</style>
</head>
<body>
${body}
<script type="module">${js}</script>
</body>
</html>
`);
console.log('Pixel-Sprite-Araci.html hazır');
