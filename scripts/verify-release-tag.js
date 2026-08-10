const packageJson = require("../package.json");

const expectedTag = `v${packageJson.version}`;
const actualTag = process.env.GITHUB_REF_NAME || process.argv[2];

// 发布标签和 package.json 版本必须一致，否则用户会下载到名称与代码不匹配的安装包。
if (!actualTag) {
  console.error("缺少发布标签。请设置 GITHUB_REF_NAME，或把标签作为命令参数传入。");
  process.exit(1);
}

if (actualTag !== expectedTag) {
  console.error(`版本不一致：当前标签是 ${actualTag}，package.json 期望 ${expectedTag}。`);
  process.exit(1);
}

console.log(`发布版本校验通过：${actualTag}`);
