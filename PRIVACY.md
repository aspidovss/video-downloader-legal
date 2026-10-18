# Privacy policy — Video Downloader Legal

*Last updated: 1.6.4*

Video Downloader Legal does **not** collect, store on any server, sell or share personal data. It has no accounts, no analytics and no servers of its own.

**What stays on your computer.** Settings, the download history and a flag that you accepted the terms of use (with the date) are kept only in your browser's local extension storage and can be cleared in the extension's settings. Downloaded files are saved by the browser to your downloads folder.

**What the extension contacts.** To list and download media it contacts only the websites you are already using, exactly as your browser would — for example the video servers of the page you are watching and, on YouTube, YouTube's own API and video servers. On Instagram, Facebook, X, TikTok, Bilibili, Canva and Vimeo it reads information about the video you are viewing from the page and from the site's own public endpoints to build the download list.

**Update check (Chrome / Edge "updater" package only).** The separate package `video-downloader-legal-chrome-updater-<version>.zip` (and `…-edge-updater-…`) for installs from GitHub checks once a day whether a newer version is out: it sends one ordinary request to the public GitHub API (`api.github.com/repos/aspidovss/video-downloader-legal/releases/latest`), without cookies and without any data about you or your downloads; like any web request, GitHub sees your IP address and browser version. The result (the latest version number and its download link) is kept in local storage, and the popup shows a notice. It can be switched off in the settings (*Notify about new versions*). It installs nothing by itself. The Firefox add-on and the regular Chrome / Edge packages never check for updates.

**Page access.** A content script reads the media elements of the pages you open so it can list them. It does not change pages and does not read form fields, passwords or other personal content. On TikTok it reads the data the page itself holds about the video on screen (title, author, cover, file addresses) to name the file and show a preview.

**Diagnostics.** The diagnostics file you can create with the 🐞 button is saved on your computer only. Links in it are masked and it contains no account data unless you enable full links in the settings. The extension never sends it anywhere — you decide whether to send it to the developer.

**Debug log (optional).** If you switch on the debug log in the settings (it is off by default), the extension keeps a text log of its own actions (found streams, downloads and their errors, results of the self-test) in your browser's local extension storage: the last 1500 lines, with links shortened to host and path, without titles or cookies. You can view, copy, save or clear it at any time. The extension never sends it anywhere — you decide whether to share it with the developer.

**Third parties.** The extension includes no third-party trackers or remote code. The only bundled third-party file is the open-source MP3 encoder lamejs, which runs locally.

**Children.** The extension is not directed at children and collects nothing from anyone.

**Changes.** Changes to this policy are published in this file and in the changelog.

**Contact:** AspidovSS, <vdl@aspidov.ru>, <https://github.com/aspidovss/video-downloader-legal>
