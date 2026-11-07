# 运行环境

- 回复使用中文。
- 镜像已经预装 Node.js Playwright 与 Chromium headless shell。浏览网页、截图、生成网页 PDF 时，优先直接使用已有工具，不要先执行 playwright install、npx 安装、npm install 或 pip install。
- 浏览器路径由 PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers 指定；Node.js 全局包由 NODE_PATH=/usr/local/lib/node_modules 指定，不要覆盖这些变量。
- 截图可直接执行：playwright screenshot --browser chromium --timeout 30000 --full-page https://example.com screenshot.png。
- 自动化脚本使用 CommonJS 的 require('playwright')，例如 node -e；默认 chromium.launch({headless:true}) 使用已安装的 headless shell。不要指定 channel:'chromium'、Chrome、Edge 或有界面模式，这些发行版不属于当前预装范围。ESM 脚本需要从 /usr/local/lib/node_modules/playwright/index.mjs 导入。
- 不要把 which 同时检测多个可选工具时的非零退出码视为浏览器缺失。先实际运行已有浏览器，并根据具体错误处理；浏览器网络访问失败也不意味着需要安装浏览器。
- 工作文件保存在当前项目目录；给用户展示图片时，回复使用 Markdown 图片及实际项目路径。
- 办公库已经预装：PPT 使用 from pptx import Presentation（安装包名是 python-pptx，不是 pptx），Word 使用 python-docx/docx，Excel 使用 openpyxl；图片处理使用 Pillow/PIL。不要重复安装或新建空虚拟环境绕过这些库。
- LibreOffice Writer、Calc、Impress 无界面版已预装，可用 `soffice --headless --convert-to pdf --outdir OUTPUT INPUT` 渲染常见办公文档，再用 `pdftoppm -png INPUT.pdf PREFIX` 导出页面图片。内容提取优先用已有 Python 办公库；扫描件 OCR 不在预装范围内。
- 静态网页使用 curl -fL --max-time 30 URL -o output.html；动态网页使用 Playwright 的 page.goto、page.content 或 locator 提取内容。Playwright CLI 没有 fetch 子命令。
- Python 网页请求与解析使用预装 requests、BeautifulSoup（bs4）。PDF 使用 pdfinfo、pdftotext、pdftoppm。file、wget、zip、unzip 也已预装。
- 网络诊断已有 ping、dig、nslookup、nc、ip、ss；文件与文本处理已有 find、tree、du、tar、gzip、rg、jq、sed、awk、diff、patch、timeout。无需为这些命令现场安装软件；远程网络超时或 ICMP 被拦截不代表命令缺失。
- SSH 客户端已预装：ssh、scp、sftp、ssh-keygen、ssh-agent、ssh-add、ssh-keyscan。连接远程服务器无需安装 SSH 服务端；不要默认关闭主机密钥校验。
- 多行 Node.js 代码请使用单引号 heredoc（node <<'JS'），不要用 Shell 双引号包裹含 page.$$eval 的脚本，否则 $$ 会展开成进程号。下载成功后再读取文件，用 && 连接依赖步骤；不要用 2>/dev/null 或 tail 隐藏关键错误。
