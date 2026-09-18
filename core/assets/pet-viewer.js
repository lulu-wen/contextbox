import * as THREE from './vendor/three.module.js'
import { GLTFLoader } from './vendor/GLTFLoader.js'

const stage = document.getElementById('quaso-stage')
const status = document.getElementById('quaso-status')
const dialog = document.getElementById('quaso-dialog')
const settings = document.getElementById('quaso-settings')
const settingsToggle = document.getElementById('quaso-settings-toggle')
const animation = document.getElementById('quaso-animation')
const retry = document.getElementById('quaso-retry')
retry.onclick = () => location.reload()
document.addEventListener('quaso:notice', event => {
  status.textContent = event.detail.message
  showDialog(true)
})
function showDialog(open) {
  dialog.hidden = !open
  stage.setAttribute('aria-expanded', String(open))
  closeSettings()
}
function closeSettings() {
  settings.hidden = true
  settingsToggle.setAttribute('aria-expanded', 'false')
}
stage.onclick = () => showDialog(dialog.hidden)
settingsToggle.onclick = () => {
  const open = settings.hidden
  showDialog(false)
  settings.hidden = !open
  settingsToggle.setAttribute('aria-expanded', String(open))
}
document.addEventListener('click', event => {
  if (!settings.contains(event.target) && !settingsToggle.contains(event.target)) closeSettings()
  if (!document.getElementById('quaso').contains(event.target)
    && !document.getElementById('cleanup-panel')?.contains(event.target)
    && !document.getElementById('cleanup-history-panel')?.contains(event.target)
    && event.target.id !== 'cleanup-demo-start'
    && event.target.id !== 'backend-mock-toggle') showDialog(false)
})
document.getElementById('quaso').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const wasSettingsOpen = !settings.hidden
    showDialog(false)
    if (wasSettingsOpen) settingsToggle.focus()
    else stage.focus()
  }
})

async function init() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(220, 220)
  renderer.setClearColor(0x000000, 0)
  stage.append(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x967354, 2.5))
  const light = new THREE.DirectionalLight(0xffffff, 3)
  light.position.set(3, 5, 4)
  scene.add(light)
  const gltf = await new GLTFLoader().loadAsync('/assets/quaso_v8.glb')
  const model = gltf.scene
  model.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(model)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())
  const extent = Math.max(size.x, size.y, size.z)
  if (!Number.isFinite(extent) || extent <= 0) throw new Error('Empty model')
  // 在外層縮放、置中，避免覆蓋 Blender 動畫的座標。
  const pivot = new THREE.Group()
  const centered = new THREE.Group()
  centered.position.copy(center).negate()
  centered.add(model)
  pivot.add(centered)
  pivot.scale.setScalar(2 / extent)
  scene.add(pivot)
  camera.position.set(0, 0.25, 4.8)
  camera.lookAt(0, 0, 0)
  const mixer = new THREE.AnimationMixer(model)
  const clip = gltf.animations.find(a => /jump/i.test(a.name))
  let mode = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'paused' : 'jump'
  let activeMode = 'jump'
  function selectAnimation() {
    mode = animation.value
    if (mode === 'paused') return // 保留目前姿勢，停止更新。
    mixer.stopAllAction()
    pivot.rotation.y = 0
    pivot.position.y = 0
    elapsed = 0
    activeMode = mode
    if (mode === 'jump' && clip) mixer.clipAction(clip).reset().play()
  }
  let previous = performance.now(), elapsed = 0
  animation.value = mode
  animation.disabled = false
  animation.onchange = selectAnimation
  selectAnimation()
  // 載入完成不覆蓋清理提醒。
  renderer.setAnimationLoop(now => {
    const delta = Math.min((now - previous) / 1000, 0.05)
    previous = now
    if (document.hidden) return
    if (mode !== 'paused' && document.getElementById('quaso').dataset.petState !== 'worried') {
      elapsed += delta
      if (activeMode === 'spin') pivot.rotation.y = (elapsed * Math.PI / 3) % (Math.PI * 2)
      else if (clip) mixer.update(delta)
      else pivot.position.y = Math.abs(Math.sin(elapsed * 3)) * 0.2
    }
    renderer.render(scene, camera)
  })
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    renderer.setAnimationLoop(null)
    status.textContent = '3D 顯示暫時中斷，請重新載入。'
    showDialog(true)
    retry.hidden = false
  })
  window.addEventListener('pagehide', () => { renderer.setAnimationLoop(null); renderer.dispose() }, { once: true })
}

init().catch(error => {
  console.error('Quaso viewer:', error)
  status.textContent = 'Quaso 暫時無法顯示。請確認伺服器與瀏覽器的 3D 功能，再重新載入。'
  showDialog(true)
  retry.hidden = false
})
