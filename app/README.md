# 霧旅 iPhone app

app 外殼直接載入 https://travel-fog.netlify.app/，並補上網頁做不到的事：

- **背景定位**：開啟「背景自動記錄」後，app 在背景也會記錄位置（`src/background.ts`），存在手機裡；下次打開 app 時交給網頁解開迷霧。
- **定位**：網頁的定位改由 app 提供（`src/bridge.ts`），不會每次都跳出網站定位詢問。

網頁更新時 app 不用重新安裝；只有改到 app 外殼（這個資料夾）才需要重新打包。

## 打包

使用 EAS Build（雲端打包，不需要 Mac）：

```bash
cd app
npm install
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios --latest
```

送到 App Store Connect 後，在 TestFlight 邀請測試者。
