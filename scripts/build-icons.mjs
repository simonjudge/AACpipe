import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const svg = await readFile(new URL('../build/icon.svg', import.meta.url));
const png = new Resvg(svg).render().asPng();
await writeFile(new URL('../build/icon.png', import.meta.url), png);
await writeFile(new URL('../build/icon.ico', import.meta.url), await pngToIco(png));
