import * as THREE from './vendor/three.module.js'
import { GLTFLoader } from './vendor/GLTFLoader.js'

const stage = document.getElementById('quaso-stage')
const status = document.getElementById('quaso-status')
const dialog = document.getElementById('quaso-dialog')
const retry = document.getElementById('quaso-retry')
const dots = document.getElementById('quaso-dialog-dots')
const content = document.getElementById('quaso-dialog-content')
const collapse = document.getElementById('quaso-dialog-collapse')
const pet = document.getElementById('quaso')
let mode = 'hidden', dismissed = false
// 只有「找到 N 個」那一句收得起來（收合之後剩三個點）。
// 主動詢問、剛做完的結果那些話一律維持展開 —— 收起來就等於沒講。
const collapsible = () => pet.dataset.petState === 'found'
  && /^(Ready to review:|Found \d+ files? that can probably be cleaned up\.|Starting with \d+ of them\.)/u.test(status.textContent.trim())
function setDialogMode(next) {
  mode = next === 'collapsed' && !collapsible() ? 'expanded' : next
  dialog.dataset.mode = mode
  if (dialog.hidden !== (mode === 'hidden')) dialog.hidden = mode === 'hidden'
  dots.hidden = mode !== 'collapsed'
  content.hidden = mode !== 'expanded'
  collapse.hidden = !collapsible()
  stage.setAttribute('aria-expanded', String(mode === 'expanded'))
}
// Flash once per entry into worried; message refreshes do not restart it.
let wasWorried = false
function updateWorriedDialog() {
  const worried = pet.dataset.petState === 'worried'
  if (worried !== wasWorried) {
    dialog.classList.toggle('worried-flash', worried)
    if (worried) {
      dismissed = false
      setDialogMode('expanded')
    }
    wasWorried = worried
  }
}
dialog.addEventListener('animationend', event => {
  if (event.animationName === 'quaso-worried-flash') dialog.classList.remove('worried-flash')
})
let messageKey = `${pet.dataset.petState}:${collapsible()}`
const observer = new MutationObserver(() => {
  updateWorriedDialog()
  const key = `${pet.dataset.petState}:${collapsible()}`
  if (key !== messageKey) {
    messageKey = key
    dismissed = false
    setDialogMode(collapsible() ? 'collapsed' : 'expanded')
  } else if (dialog.hidden || dismissed) setDialogMode('hidden')
  else setDialogMode(mode === 'hidden' ? (collapsible() ? 'collapsed' : 'expanded') : mode)
})
observer.observe(status, { childList: true, subtree: true, characterData: true })
observer.observe(pet, { attributes: true, attributeFilter: ['data-pet-state'] })
observer.observe(dialog, { attributes: true, attributeFilter: ['hidden'] })
dots.onclick = () => setDialogMode('expanded')
collapse.onclick = () => { setDialogMode('collapsed'); dots.focus() }
document.getElementById('quaso-dialog-close').onclick = () => { dismissed = true; setDialogMode('hidden'); stage.focus() }
setDialogMode(collapsible() ? 'collapsed' : dialog.hidden ? 'hidden' : 'expanded')
updateWorriedDialog()
window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
retry.onclick = () => location.reload()
document.addEventListener('quaso:notice', event => {
  status.textContent = event.detail.message
  showDialog(true)
})
function showDialog(open) {
  setDialogMode(open ? 'expanded' : 'hidden')
}
stage.onclick = () => { dismissed = false; setDialogMode(collapsible() ? 'collapsed' : 'expanded') }
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
    const panels = [...document.querySelectorAll('#cleanup-panel, #cleanup-history-panel')]
    const panelOpen = () => panels.some(p => p.open)
    /**
     * 寵物該不該待在瀏覽器的 top layer。
     *
     * WebGL 的 canvas 疊不到 <dialog> 上面，所以這裡把它掛成 popover 借用 top layer。
     * **但面板打開的時候要讓開**（2026-09-21 實機回報）：面板寬 680px 置中、寵物固定在
     * 右下角佔 220px，視窗窄於約 1160px 時牠就蓋在面板右緣上 —— 正好是每一列的
     * 「Clean up / Not this one」與連拍區右邊那張縮圖。canvas 是 pointer-events: none，
     * 按得到但看不到，比按不到更難查。
     *
     * 讓開的方式是**把 popover 屬性拿掉**，不是 hidePopover()：popover 藏起來等於
     * display:none，貓會整隻消失；拿掉屬性牠就回到一般的堆疊順序，安安靜靜待在
     * 面板的遮罩後面 —— 這本來就是 modal 該有的樣子。動畫迴圈本來就有這條路
     * （沒有 popover 時用 transform 定位）。
     */
    const syncPetLayer = () => {
      if (panelOpen()) {
        if (canvas.matches(':popover-open')) canvas.hidePopover()
        if (canvas.hasAttribute('popover')) {
          canvas.removeAttribute('popover')
          canvas.style.left = ''
          canvas.style.top = ''
        }
        return
      }
      if (!canvas.hasAttribute('popover')) {
        canvas.setAttribute('popover', 'manual')
        canvas.style.transform = ''
      }
      if (canvas.matches(':popover-open')) canvas.hidePopover()
      canvas.showPopover()
      alignCanvas()
    }
    syncPetLayer()
    const layerObserver = new MutationObserver(syncPetLayer)
    for (const panel of panels) {
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
  for (const side of ['left', 'right']) {
    const name = `move_${side}_eye`
    const eye = model.getObjectByName(`eye_${side}`)
    if (!findClip(name) && eye) {
      const angle = eye.rotation.z
      clips.set(name, new THREE.AnimationClip(name, 0.8, [
        new THREE.NumberKeyframeTrack(`${eye.uuid}.rotation[z]`, [0, 0.4, 0.8],
          [angle, angle + (side === 'left' ? 0.12 : -0.12), angle]),
      ]))
    }
  }
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
  let jumpStartScreenY = 0
  const idlePauseDuration = 3
  let idlePhase = '', idleDuration = 0
  let idlePaused = false
  function playIdlePhase(phase) {
    // Keep the clamped idle action active while both eye animations play.
    if (phase !== 'eyes') mixer.stopAllAction()
    idlePaused = false
    idlePhase = phase
    elapsed = 0
    const names = phase === 'eyes' ? ['move_left_eye', 'move_right_eye']
      : ['idle']
    const phaseClips = names.map(findClip).filter(Boolean)
    idleDuration = Math.max(0.1, ...phaseClips.map(clip => clip.duration))
    activeMode = names[0]
    for (const clip of phaseClips) {
      const action = mixer.clipAction(clip).reset().setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
      action.play()
    }
  }
  function advanceIdle() {
    if (idlePhase === 'rest') {
      playIdlePhase('eyes')
      return
    }
    // Keep idle and both eyes clamped at their final frames during the pause.
    idlePaused = true
    elapsed = 0
  }
  function iconPosition(id) {
    const rect = stage.getBoundingClientRect()
    const icon = document.getElementById(id).getBoundingClientRect()
    return new THREE.Vector2(icon.left + icon.width / 2 - rect.left - rect.width / 2,
      icon.top - 78 - rect.top - rect.height / 2)
  }

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
    if (state === 'idle') {
      playIdlePhase('rest')
    } else if (state === 'found') {
      const origin = iconPosition('quaso-history-open')
      const destination = iconPosition('quaso-cleanup-alert')
      const dx = destination.x - origin.x, dy = destination.y - origin.y
      const worldPerPixel = 2 * cameraOffset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / 220
      walkStart.copy(pivot.position)
      walkEnd.copy(walkStart)
      walkEnd.x += dx * worldPerPixel
      walkEnd.y -= dy * worldPerPixel
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
    if (state !== 'found' && state !== 'idle') action.play()
    if (!protectedRun && queue.length) request(queue.shift())
  }

  function request(state, immediate = false) {
    if (reducedMotion) return

    const isOperation =
      state === 'cleaning' ||
      state === 'restoring'

    // 新操作開始：
    // 上一次操作還沒播放的 happy 已經過期，直接丟掉。
    if (isOperation) {
      // queue 裡移除所有舊 happy
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i] === 'happy') {
          queue.splice(i, 1)
        }
      }

      // 如果 happy 還在 1 秒 transition 中，也取消
      if (pendingState === 'happy') {
        if (transitionTimer) {
          clearTimeout(transitionTimer)
          transitionTimer = null
        }

        pendingState = null
      }

      // 如果 happy 已經真的在播放，
      // 新操作可以直接打斷它。
      if (displayedState === 'happy') {
        protectedRun = false
        start(state)
        return
      }
    }

    // worried 最高優先
    if (state === 'worried') {
      queue.length = 0

      if (transitionTimer) {
        clearTimeout(transitionTimer)
        transitionTimer = null
      }

      pendingState = null
      start(state)
      return
    }

    // cleaning / restoring 等 protected animation
    // 至少完整播放一次。
    if (protectedRun || protectedStates.has(pendingState)) {
      if (
        (queue.at(-1) ?? pendingState ?? displayedState) !== state
      ) {
        queue.push(state)
      }

      return
    }

    if (transitionTimer) {
      clearTimeout(transitionTimer)
    }

    pendingState = state

    const run = () => {
      transitionTimer = null
      pendingState = null
      start(state)
    }

    if (immediate) {
      run()
    } else {
      transitionTimer = setTimeout(run, 1000)
    }
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
      if (displayedState === 'idle') {
        if (idlePaused) {
          if (elapsed >= idlePauseDuration) {
            playIdlePhase('eyes')
          }
        } else {
          mixer.update(delta)
          if (elapsed >= idleDuration) advanceIdle()
        }
      }
      else if (activeMode === 'spin') pivot.rotation.y = (elapsed * Math.PI / 3) % (Math.PI * 2)
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
    const origin = iconPosition('quaso-history-open')
    let offsetX = origin.x + screenPosition.x * stageBounds.width / 2
    let offsetY = origin.y - screenPosition.y * stageBounds.height / 2
    if (displayedState === 'found') {
      const destination = iconPosition('quaso-cleanup-alert')
      const progress = Math.min(elapsed / walkDuration, 1)
      const fraction = foundPhase === 'jump' ? 1 : foundPhase === 'back' ? 1 - progress : progress
      offsetX = THREE.MathUtils.lerp(origin.x, destination.x, fraction)
      offsetY = THREE.MathUtils.lerp(origin.y, destination.y, fraction)
      if (foundPhase === 'jump') offsetY -= (screenPosition.y - jumpStartScreenY) * stageBounds.height / 2
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
    status.textContent = 'The 3D view stopped. Please reload.'
    showDialog(true)
    retry.hidden = false
  })
  window.addEventListener('pagehide', () => { renderer.setAnimationLoop(null); renderer.dispose() }, { once: true })
}

init().catch(error => {
  console.error('Quaso viewer:', error)
  status.textContent = 'Quaso cannot be shown right now. Check the server and your browser\'s 3D support, then reload.'
  showDialog(true)
  retry.hidden = false
})
