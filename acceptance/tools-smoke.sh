#!/bin/bash
set -euo pipefail
# Run inside the image as its default node user, with --network none.
test "$(id -u)" = 1000
for tool in curl wget ssh scp sftp ssh-keygen ssh-agent ssh-add ssh-keyscan file zip unzip tar gzip find tree du rg jq sed awk diff patch timeout ping dig nslookup nc ip ss pdfinfo pdftotext pdftoppm playwright soffice ffmpeg; do command -v "$tool" >/dev/null; done
test "$(command -v ffmpeg)" = /usr/local/bin/ffmpeg
! command -v ffplay >/dev/null
! command -v ffprobe >/dev/null
ssh -V
ping -c 1 -W 2 127.0.0.1 >/dev/null
ip link show lo >/dev/null
ss -ltn >/dev/null
echo 'PASS network / file / text commands (loopback only, no external network)'
test "$(pip --version)" = "$(python -m pip --version)"
test "$(pip3 --version)" = "$(python3 -m pip --version)"
testdir=$(mktemp -d /tmp/tools-smoke.XXXXXX)
trap 'rm -rf "$testdir"' EXIT
cd "$testdir"
ssh-keygen -q -t ed25519 -N '' -f test_key
ssh-keygen -l -f test_key.pub >/dev/null
echo 'PASS SSH client commands / key generation'
python <<'PY'
from docx import Document
from pptx import Presentation
from openpyxl import Workbook, load_workbook
from PIL import Image
from bs4 import BeautifulSoup
import requests
document = Document()
document.add_paragraph('中文办公验收')
document.save('sample.docx')
assert Document('sample.docx').paragraphs[0].text == '中文办公验收'
deck = Presentation()
deck.slides.add_slide(deck.slide_layouts[0]).shapes.title.text = '中文演示验收'
deck.save('sample.pptx')
assert Presentation('sample.pptx').slides[0].shapes.title.text == '中文演示验收'
book = Workbook()
book.active['A1'] = '中文表格验收'
book.save('sample.xlsx')
assert load_workbook('sample.xlsx').active['A1'].value == '中文表格验收'
Image.new('RGB', (10, 10), 'red').save('sample.png')
assert BeautifulSoup('<h1>中文网页验收</h1>', 'html.parser').h1.get_text() == '中文网页验收'
assert requests.Request('GET', 'https://example.com').prepare().url == 'https://example.com/'
print('PASS Office / Pillow / requests / BeautifulSoup')
PY
mkdir word-pdf ppt-pdf sheet-pdf office-images
soffice --headless -env:UserInstallation="file://$testdir/lo-profile" --convert-to pdf --outdir word-pdf sample.docx
soffice --headless -env:UserInstallation="file://$testdir/lo-profile" --convert-to pdf --outdir ppt-pdf sample.pptx
soffice --headless -env:UserInstallation="file://$testdir/lo-profile" --convert-to pdf --outdir sheet-pdf sample.xlsx
pdftotext word-pdf/sample.pdf word.txt
pdftotext ppt-pdf/sample.pdf ppt.txt
pdftotext sheet-pdf/sample.pdf sheet.txt
grep -q '中文办公验收' word.txt
grep -q '中文演示验收' ppt.txt
grep -q '中文表格验收' sheet.txt
for name in word ppt sheet; do
  source="$name-pdf/sample.pdf"
  pdftoppm -f 1 -singlefile -png "$source" "office-images/$name" >/dev/null 2>&1
  test -s "office-images/$name.png"
done
echo 'PASS LibreOffice Word / Excel / PowerPoint PDF and page image conversion'
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=64x64:rate=2 -t 1 -c:v mpeg4 sample.avi
mkdir video-frames
ffmpeg -hide_banner -loglevel error -i sample.avi -vf fps=1 video-frames/frame-%02d.png
test -s video-frames/frame-01.png
file sample.avi video-frames/frame-01.png
echo 'PASS FFmpeg video creation and frame extraction'
node <<'JS'
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><head><title>浏览器验收</title></head><body><h1>中文网页验收</h1></body></html>');
    const headings = await page.$$eval('h1', elements => elements.map(element => element.textContent));
    if (headings[0] !== '中文网页验收') throw new Error('Browser extraction failed');
    await page.screenshot({ path: 'browser.png' });
    await page.pdf({ path: 'browser.pdf' });
    console.log('PASS preinstalled Chromium / DOM extraction / screenshot / PDF');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
file sample.docx sample.pptx sample.xlsx browser.png browser.pdf
pdfinfo browser.pdf >/dev/null
pdftotext browser.pdf output.txt
grep -q '中文网页验收' output.txt
pdftoppm -scale-to 100 -singlefile -png browser.pdf pdf-preview >/dev/null 2>&1
zip -q bundle.zip sample.docx sample.pptx sample.xlsx
unzip -t bundle.zip >/dev/null
echo 'PASS file identification / PDF extraction and rendering / ZIP'
