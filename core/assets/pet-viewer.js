import * as THREE from './vendor/three.module.js'
import { GLTFLoader } from './vendor/GLTFLoader.js'

const stage = document.getElementById('quaso-stage')
const status = document.getElementById('quaso-status')
const turn = document.getElementById('quaso-turn')
const motion = document.getElementById('quaso-motion')
const retry = document.getElementById('quaso-retry')
retry.onclick = () => location.reload()

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
  const clip = gltf.animations.find(a => /idle/i.test(a.name)) ?? gltf.animations[0]
  if (clip) mixer.clipAction(clip).play()
  let paused = matchMedia('(prefers-reduced-motion: reduce)').matches
  const updateLabel = () => { motion.textContent = paused ? '播放動畫' : '暫停動畫' }
  updateLabel()
  turn.disabled = motion.disabled = false
  turn.onclick = () => { pivot.rotation.y += Math.PI / 4 }
  motion.onclick = () => { paused = !paused; updateLabel() }
  status.textContent = '我是 Quaso，今天也陪著你！'
  let previous = performance.now(), elapsed = 0
  renderer.setAnimationLoop(now => {
    const delta = Math.min((now - previous) / 1000, 0.05)
    previous = now
    if (document.hidden) return
    if (!paused) {
      elapsed += delta
      if (clip) mixer.update(delta)
      else pivot.position.y = Math.sin(elapsed * 2) * 0.035
    }
    renderer.render(scene, camera)
  })
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    renderer.setAnimationLoop(null)
    status.textContent = '3D 顯示暫時中斷，請重新載入。'
    retry.hidden = false
  })
  window.addEventListener('pagehide', () => { renderer.setAnimationLoop(null); renderer.dispose() }, { once: true })
}

init().catch(error => {
  console.error('Quaso viewer:', error)
  status.textContent = 'Quaso 暫時無法顯示。請確認伺服器與瀏覽器的 3D 功能，再重新載入。'
  retry.hidden = false
})
