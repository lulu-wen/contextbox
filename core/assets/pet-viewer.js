import * as THREE from './vendor/three.module.js'
import { GLTFLoader } from './vendor/GLTFLoader.js'

const stage = document.getElementById('quaso-stage')
const status = document.getElementById('quaso-status')
const dialog = document.getElementById('quaso-dialog')
const retry = document.getElementById('quaso-retry')
retry.onclick = () => location.reload()
document.addEventListener('quaso:notice', event => {
  status.textContent = event.detail.message
  showDialog(true)
})
function showDialog(open) {
  dialog.hidden = !open
  stage.setAttribute('aria-expanded', String(open))
}
stage.onclick = () => showDialog(dialog.hidden)
document.addEventListener('click', event => {
  if (!document.getElementById('quaso').contains(event.target)
    && !document.getElementById('cleanup-panel')?.contains(event.target)
    && !document.getElementById('cleanup-history-panel')?.contains(event.target)
    && event.target.id !== 'cleanup-demo-start'
    && event.target.id !== 'backend-mock-toggle') showDialog(false)
})
document.getElementById('quaso').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    showDialog(false)
    stage.focus()
  }
})

async function init() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(220, 220)
  renderer.setClearColor(0x000000, 0)
  stage.append(renderer.domElement)
  const canvas = renderer.domElement
  // Only the transparent drawing surface belongs to the browser top layer.
  // Pointer events pass through to the existing stage and controls.
  if (typeof canvas.showPopover === 'function') {
    canvas.setAttribute('popover', 'manual')
    const alignCanvas = () => {
      const rect = stage.getBoundingClientRect()
      canvas.style.left = `${rect.left}px`
      canvas.style.top = `${rect.top}px`
    }
    const bringPetToFront = () => {
      if (canvas.matches(':popover-open')) canvas.hidePopover()
      canvas.showPopover()
      alignCanvas()
    }
    bringPetToFront()
    const layerObserver = new MutationObserver(bringPetToFront)
    for (const panel of document.querySelectorAll('#cleanup-panel, #cleanup-history-panel')) {
      layerObserver.observe(panel, { attributes: true, attributeFilter: ['open'] })
    }
    window.addEventListener('resize', alignCanvas)
    window.addEventListener('pagehide', () => {
      layerObserver.disconnect()
      window.removeEventListener('resize', alignCanvas)
    }, { once: true })
  }
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x967354, 2.5))
  const light = new THREE.DirectionalLight(0xffffff, 3)
  light.position.set(3, 5, 4)
  scene.add(light)
  const gltf = await new GLTFLoader().loadAsync('/assets/quaso_v10.glb')
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
  const animatedBounds = new THREE.Box3()
  const cameraTarget = new THREE.Vector3()
  const cameraOffset = new THREE.Vector3(0, 0.25, 4.8)
  // Keep the original view as the reference for the pet's on-screen movement.
  const referenceCamera = camera.clone()
  referenceCamera.updateMatrixWorld(true)
  const screenPosition = new THREE.Vector3()
  const mixer = new THREE.AnimationMixer(model)
  const clips = new Map(gltf.animations.map(clip => [clip.name.toLowerCase(), clip]))
  const findClip = name => clips.get(name) || gltf.animations.find(clip => clip.name.toLowerCase().includes(name))
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  let activeMode = 'idle'
  let displayedState = null, protectedRun = false, pendingState = null, transitionTimer = null, playVersion = 0
  const queue = []
  const protectedStates = new Set(['cleaning', 'restoring', 'happy'])
  const clipForState = state => state === 'thinking' ? 'idle' : state === 'found' ? 'walk' : state
  const walkStart = new THREE.Vector3()
  const walkEnd = new THREE.Vector3()
  let walkDuration = 0, walkHeading = 0, walkStartHeading = 0
  let foundPhase = 'out', foundFinished = null, foundTimer = null
  const foundOrigin = new THREE.Vector2()
  const foundTravel = new THREE.Vector2()
  let jumpStartScreenY = 0

  function start(state) {
    const clip = findClip(clipForState(state))
    if (!clip) return
    const version = ++playVersion
    clearTimeout(foundTimer)
    if (foundFinished) mixer.removeEventListener('finished', foundFinished)
    foundFinished = null
    if (displayedState === 'found' && state !== 'found') {
      pivot.position.copy(walkStart)
    }
    displayedState = state
    protectedRun = protectedStates.has(state)
    mixer.stopAllAction()
    pivot.rotation.y = 0
    pivot.position.y = 0
    elapsed = 0
    activeMode = clipForState(state)
    const action = mixer.clipAction(clip).reset()
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.clampWhenFinished = false
    if (state === 'found') {
      model.updateWorldMatrix(true, true)
      animatedBounds.setFromObject(model, true).getCenter(cameraTarget)
      screenPosition.copy(cameraTarget).project(referenceCamera)
      const stageRect = stage.getBoundingClientRect()
      foundOrigin.set(screenPosition.x * stageRect.width / 2, -screenPosition.y * stageRect.height / 2)
      const targetRect = document.getElementById('quaso-cleanup-alert').getBoundingClientRect()
      const dx = targetRect.left + targetRect.width / 2 - (stageRect.left + stageRect.width / 2 + foundOrigin.x)
      const dy = targetRect.top + targetRect.height / 2 - (stageRect.top + stageRect.height / 2 + foundOrigin.y)
      const distance = Math.hypot(dx, dy)
      const travel = Math.min(45, distance * 0.5)
      foundTravel.set(dx, dy).multiplyScalar(distance > 0 ? travel / distance : 0)
      const worldPerPixel = 2 * cameraOffset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / 220
      walkStart.copy(pivot.position)
      walkEnd.copy(walkStart)
      if (distance > 0) {
        walkEnd.x += dx / distance * travel * worldPerPixel
        walkEnd.y -= dy / distance * travel * worldPerPixel
      }
      walkDuration = clip.duration
      // Turn toward the icon using the model's visible front orientation.
      walkHeading = dx < 0 ? -Math.PI / 2 : Math.PI / 2
      let phaseAction
      const playPhase = phase => {
        foundPhase = phase
        elapsed = 0
        walkStartHeading = pivot.rotation.y
        activeMode = phase === 'jump' ? 'jump' : 'walk'
        if (phase === 'jump') pivot.rotation.y = 0
        mixer.stopAllAction()
        phaseAction = mixer.clipAction(findClip(activeMode)).reset().setLoop(THREE.LoopOnce, 1)
        phaseAction.clampWhenFinished = true
        phaseAction.play()
        if (phase === 'jump') {
          // Sample the jump's first pose, not the preceding walk pose.
          mixer.update(0)
          model.updateWorldMatrix(true, true)
          animatedBounds.setFromObject(model, true).getCenter(cameraTarget)
          jumpStartScreenY = screenPosition.copy(cameraTarget).project(referenceCamera).y
        }
      }
      foundFinished = event => {
        if (version !== playVersion || event.action !== phaseAction) return
        if (foundPhase !== 'jump') pivot.position.copy(foundPhase === 'out' ? walkEnd : walkStart)
        const next = foundPhase === 'out' ? 'jump' : foundPhase === 'jump' ? 'back' : 'out'
        foundTimer = setTimeout(() => {
          if (version === playVersion && !pendingState) playPhase(next)
        }, 160)
      }
      mixer.addEventListener('finished', foundFinished)
      playPhase('out')
    } else if (protectedRun) {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
      mixer.addEventListener('finished', function onFinished(event) {
        if (version !== playVersion || event.action !== action) return
        mixer.removeEventListener('finished', onFinished)
        protectedRun = false
        if (queue.length) {
          request(queue.shift())
        } else {
          action.reset().setLoop(THREE.LoopRepeat, Infinity).play()
        }
      })
    }
    if (state !== 'found') action.play()
    if (!protectedRun && queue.length) request(queue.shift())
  }

  function request(state, immediate = false) {
    if (reducedMotion) {
      return
    }
    if (state === 'worried') {
      queue.length = 0
    } else if (protectedRun || protectedStates.has(pendingState)) {
      if ((queue.at(-1) ?? pendingState ?? displayedState) !== state) queue.push(state)
      return
    }
    if (transitionTimer) clearTimeout(transitionTimer)
    pendingState = state
    const run = () => { transitionTimer = null; pendingState = null; start(state) }
    if (immediate || state === 'worried') run()
    else transitionTimer = setTimeout(run, 1000)
  }
  let previous = performance.now(), elapsed = 0
  document.addEventListener('quaso:statechange', event => {
    request(event.detail.state)
  })
  const initialState = document.getElementById('quaso').dataset.petState || 'idle'
  request(initialState, true)
  // 載入完成不覆蓋清理提醒。
  renderer.setAnimationLoop(now => {
    const delta = Math.min((now - previous) / 1000, 0.05)
    previous = now
    if (document.hidden) return
    if (!reducedMotion && !transitionTimer) {
      elapsed += delta
      if (activeMode === 'spin') pivot.rotation.y = (elapsed * Math.PI / 3) % (Math.PI * 2)
      else if (findClip(activeMode)) {
        if (displayedState === 'found' && activeMode === 'walk') {
          const progress = Math.min(elapsed / walkDuration, 1)
          const returning = foundPhase === 'back'
          pivot.position.lerpVectors(returning ? walkEnd : walkStart, returning ? walkStart : walkEnd, progress)
          const heading = returning ? -walkHeading : walkHeading
          pivot.rotation.y = THREE.MathUtils.lerp(walkStartHeading, heading, Math.min(elapsed / 0.2, 1))
        }
        mixer.update(delta)
      }
      else pivot.position.y = Math.abs(Math.sin(elapsed * 3)) * 0.2
    }
    // Move the drawing window with the pet instead of pinning it on screen.
    model.updateWorldMatrix(true, true)
    animatedBounds.setFromObject(model, true).getCenter(cameraTarget)
    screenPosition.copy(cameraTarget).project(referenceCamera)
    const stageBounds = stage.getBoundingClientRect()
    let offsetX = screenPosition.x * stageBounds.width / 2
    let offsetY = -screenPosition.y * stageBounds.height / 2
    if (displayedState === 'found') {
      // Use screen coordinates for navigation; turning/model root motion must
      // not redirect the walk toward a different icon.
      const progress = Math.min(elapsed / walkDuration, 1)
      const fraction = foundPhase === 'jump' ? 1 : foundPhase === 'back' ? 1 - progress : progress
      offsetX = foundOrigin.x + foundTravel.x * fraction
      offsetY = foundOrigin.y + foundTravel.y * fraction
      if (foundPhase === 'jump') {
        offsetY -= (screenPosition.y - jumpStartScreenY) * stageBounds.height / 2
      }
    }
    if (canvas.hasAttribute('popover')) {
      canvas.style.left = `${stageBounds.left + offsetX}px`
      canvas.style.top = `${stageBounds.top + offsetY}px`
    } else {
      canvas.style.transform = `translate(${offsetX}px, ${offsetY}px)`
    }
    camera.position.copy(cameraTarget).add(cameraOffset)
    camera.lookAt(cameraTarget)
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
