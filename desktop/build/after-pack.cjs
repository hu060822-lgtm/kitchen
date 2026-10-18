// electron-builder afterPack：在 Linux 上打包 Windows 版時沒有 wine（rcedit 不能用），
// 改用純 JavaScript 的 resedit 寫入 exe 的圖示與版本資訊。
const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const { appOutDir, packager } = context;
  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exe = fs.existsSync(path.join(appOutDir, exeName)) ? path.join(appOutDir, exeName) : path.join(appOutDir, `${packager.executableName}.exe`);
  const data = fs.readFileSync(exe);
  const pe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));

  const version = packager.appInfo.version;
  const [a, b, c] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = vis[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const langs = vi.getAllLanguagesForStringValues();
  for (const l of langs.length ? langs : [{ lang: 1033, codepage: 1200 }]) {
    vi.setStringValues(l, {
      FileDescription: 'NULL：最後一桌',
      ProductName: 'NULL：最後一桌',
      CompanyName: 'NULL: Last Table',
      LegalCopyright: '',
      OriginalFilename: path.basename(exe),
      InternalName: 'NullLastTable',
      FileVersion: version,
      ProductVersion: version,
    });
  }
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log(`  • resedit: 已寫入圖示與版本資訊 ${path.basename(exe)}`);
};
