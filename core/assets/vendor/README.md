# Quaso 的瀏覽器端 3D 程式庫

Three.js 0.180.0，MIT 授權（見 THREE-LICENSE.txt）。
來源：https://registry.npmjs.org/three/-/three-0.180.0.tgz
文件：https://threejs.org/docs/

保留 build/three.module.js、build/three.core.js、examples/jsm/loaders/GLTFLoader.js
與 examples/jsm/utils/BufferGeometryUtils.js。只修改後兩者的 import 路徑以使用同目錄模組。

這是顯示 GLB 所需的前端第三方程式碼例外。後端仍使用 Node 內建模組，
不需要 npm install；頁面不使用外部 CDN。更新時請同步更新這四個檔案與授權。
