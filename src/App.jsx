import { useState, useRef, useEffect } from 'react'
import './App.css'
import { supabase } from './supabaseClient'

const GRID_SIZE = 28
const SPACE_WIDTH = 84
const SPACE_HEIGHT = 140
const SNAP_DISTANCE = 55

const initialSpaces = [
  { id: 1, x: 84, y: 112, label: '01', rotation: 0, lotId: 1 },
  { id: 2, x: 168, y: 112, label: '02', rotation: 0, lotId: 1 },
  { id: 3, x: 252, y: 112, label: '03', rotation: 0, lotId: 1 },
  { id: 4, x: 336, y: 112, label: '04', rotation: 0, lotId: 1 },
  { id: 5, x: 420, y: 112, label: '05', rotation: 0, lotId: 1 },
]

const initialVehicles = []

function rectsTouch(a, b) {
  const aRight = a.x + a.width
  const aBottom = a.y + a.height
  const bRight = b.x + b.width
  const bBottom = b.y + b.height

  const xOverlap =
    a.x <= bRight && aRight >= b.x

  const yOverlap =
    a.y <= bBottom && aBottom >= b.y

  return xOverlap && yOverlap
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart
}

// Recomputes which areas belong together as one "object" based purely on
// whether their rectangles touch or overlap. Each area keeps its own x/y/
// width/height, only groupId changes, so custom L-shapes etc. stay intact.
function computeAreaGroups(list) {
  const parent = {}

  list.forEach((area) => {
    parent[area.id] = area.id
  })

  function find(id) {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]]
      id = parent[id]
    }

    return id
  }

  function union(idA, idB) {
    const rootA = find(idA)
    const rootB = find(idB)

    if (rootA !== rootB) {
      parent[rootA] = rootB
    }
  }

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (rectsTouch(list[i], list[j])) {
        union(list[i].id, list[j].id)
      }
    }
  }

  const groupSizes = {}

  list.forEach((area) => {
    const root = find(area.id)
    groupSizes[root] = (groupSizes[root] || 0) + 1
  })

  return list.map((area) => {
    const root = find(area.id)

    return {
      ...area,
      groupId:
        groupSizes[root] > 1 ? root : null,
    }
  })
}

// Roads (and any other grouped objects) live in a shared, unbounded
// coordinate space across all lots, so grouping must only ever consider
// items belonging to the same lot, otherwise two unrelated lots could
// accidentally "touch" and merge just because their coordinates overlap.
function computeGroupsPerLot(list) {
  const byLot = {}

  list.forEach((item) => {
    const key = item.lotId || 'none'

    if (!byLot[key]) {
      byLot[key] = []
    }

    byLot[key].push(item)
  })

  return Object.values(byLot).flatMap(
    (lotItems) => computeAreaGroups(lotItems)
  )
}

// Which sides of this area touch another area in the same group, so the
// border on that side can be hidden to make the group read as one shape.
const SEAM_OVERLAP = 3

// Computes, for every pair of areas that touch or overlap, the exact
// rectangle where their borders would visually clash. A thin edge-to-edge
// touch gets a small strip just thick enough to cover both border lines.
// A genuine overlap gets erased exactly, with no extra margin, so real
// outer borders elsewhere on either shape are never touched.
function getSeamSegments(list) {
  const segments = []

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]

      const left = Math.max(a.x, b.x)
      const right = Math.min(
        a.x + a.width,
        b.x + b.width
      )
      const top = Math.max(a.y, b.y)
      const bottom = Math.min(
        a.y + a.height,
        b.y + b.height
      )

      if (right < left || bottom < top) {
        continue
      }

      const width = right - left
      const height = bottom - top

      if (width === 0 && height === 0) {
        continue
      }

      const marginX =
        width === 0 ? SEAM_OVERLAP : 0

      const marginY =
        height === 0 ? SEAM_OVERLAP : 0

      segments.push({
        id: 's-' + a.id + '-' + b.id,
        aId: a.id,
        bId: b.id,
        x: left - marginX,
        y: top - marginY,
        width: width + marginX * 2,
        height: height + marginY * 2,
      })
    }
  }

  return segments
}

const OBJECT_COLORS = [
  '#5b6c7c',
  '#3d6f9d',
  '#3d9b69',
  '#d98b1f',
  '#c94b4b',
  '#8b5cf6',
  '#0891b2',
  '#be185d',
]

const STATUS_LEGEND = [
  { value: 'reserved', label: 'Reserved', color: '#eab308' },
  { value: 'sold', label: 'Sold', color: '#dc2626' },
  { value: 'waiting-pdi', label: 'Waiting for PDI', color: '#f97316' },
  { value: 'waiting-cleaning', label: 'Waiting for cleaning', color: '#8b5cf6' },
  { value: 'cleaned', label: 'Cleaned', color: '#3b82f6' },
  { value: 'ready', label: 'Ready for delivery', color: '#22c55e' },
  { value: 'demo', label: 'Demo', color: '#0891b2' },
  { value: 'test-drive', label: 'Test drive', color: '#db2777' },
]

// Fits a label's text to whatever box size it's been resized to,
// shrinking or growing the font so it stays readable without
// overflowing, rather than staying a fixed size regardless of box.
function computeLabelFontSize(width, height, text) {
  const availableWidth = Math.max(
    width - 16,
    10
  )

  const availableHeight = Math.max(
    height - 10,
    8
  )

  const charCount = Math.max(
    (text || '').length,
    1
  )

  const byWidth =
    availableWidth / (charCount * 0.58)

  const byHeight = availableHeight * 0.55

  const fitted = Math.min(byWidth, byHeight)

  return Math.max(8, Math.min(fitted, 30))
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '')

  const r = parseInt(
    clean.substring(0, 2),
    16
  )

  const g = parseInt(
    clean.substring(2, 4),
    16
  )

  const b = parseInt(
    clean.substring(4, 6),
    16
  )

  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Seams sit on top of two overlapping translucent fills, so a translucent
// patch there wouldn't fully hide the border underneath. This precomputes
// the equivalent solid color instead (color blended over the canvas bg).
function blendOverCanvasBg(hex, alpha) {
  const clean = hex.replace('#', '')

  const r = parseInt(
    clean.substring(0, 2),
    16
  )

  const g = parseInt(
    clean.substring(2, 4),
    16
  )

  const b = parseInt(
    clean.substring(4, 6),
    16
  )

  const bgR = 238
  const bgG = 241
  const bgB = 243

  const outR = Math.round(
    r * alpha + bgR * (1 - alpha)
  )

  const outG = Math.round(
    g * alpha + bgG * (1 - alpha)
  )

  const outB = Math.round(
    b * alpha + bgB * (1 - alpha)
  )

  return `rgb(${outR}, ${outG}, ${outB})`
}

const REMEMBER_ME_KEY = 'car-finder-remember-me'

function LoginScreen() {
  const [mode, setMode] = useState('signIn') // 'signIn' | 'signUp'
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] =
    useState('')
  const [rememberMe, setRememberMe] = useState(
    true
  )
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [submitting, setSubmitting] = useState(
    false
  )

  const switchMode = (nextMode) => {
    setMode(nextMode)
    setError(null)
    setInfo(null)
    setPassword('')
    setConfirmPassword('')
  }

  const handleSignIn = async () => {
    const { error: signInError } =
      await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

    if (signInError) {
      setError(signInError.message)
      return
    }

    localStorage.setItem(
      REMEMBER_ME_KEY,
      rememberMe ? 'true' : 'false'
    )
  }

  const handleSignUp = async () => {
    if (!username.trim()) {
      setError('Choose a username.')
      return
    }

    if (password !== confirmPassword) {
      setError("Passwords don't match.")
      return
    }

    if (password.length < 6) {
      setError(
        'Password must be at least 6 characters.'
      )
      return
    }

    const { data, error: signUpError } =
      await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            username: username.trim(),
          },
        },
      })

    if (signUpError) {
      setError(signUpError.message)
      return
    }

    if (!data.session) {
      setInfo(
        'Account created. Check your email to confirm it, then sign in.'
      )

      switchMode('signIn')
      return
    }

    localStorage.setItem(
      REMEMBER_ME_KEY,
      rememberMe ? 'true' : 'false'
    )
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    setError(null)
    setInfo(null)
    setSubmitting(true)

    if (mode === 'signIn') {
      await handleSignIn()
    } else {
      await handleSignUp()
    }

    setSubmitting(false)
  }

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError(
        'Enter your email above first, then click "Forgot password".'
      )
      return
    }

    setError(null)
    setInfo(null)

    const { error: resetError } =
      await supabase.auth.resetPasswordForEmail(
        email.trim()
      )

    if (resetError) {
      setError(resetError.message)
      return
    }

    setInfo(
      'Check your email for a reset link.'
    )
  }

  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={handleSubmit}
      >
        <div className="login-brand">
          Car Finder
        </div>

        <div className="login-subtitle">
          {mode === 'signIn'
            ? 'Sign in to continue'
            : 'Create your account'}
        </div>

        <label className="login-label">
          Email
        </label>

        <input
          type="email"
          value={email}
          onChange={(event) =>
            setEmail(event.target.value)
          }
          className="login-input"
          autoFocus
          required
        />

        {mode === 'signUp' && (
          <>
            <label className="login-label">
              Username
            </label>

            <input
              type="text"
              value={username}
              onChange={(event) =>
                setUsername(event.target.value)
              }
              className="login-input"
              required
            />
          </>
        )}

        <label className="login-label">
          Password
        </label>

        <input
          type="password"
          value={password}
          onChange={(event) =>
            setPassword(event.target.value)
          }
          className="login-input"
          required
        />

        {mode === 'signUp' && (
          <>
            <label className="login-label">
              Confirm password
            </label>

            <input
              type="password"
              value={confirmPassword}
              onChange={(event) =>
                setConfirmPassword(
                  event.target.value
                )
              }
              className="login-input"
              required
            />
          </>
        )}

        <div className="login-row">
          <label className="login-remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) =>
                setRememberMe(
                  event.target.checked
                )
              }
            />
            Remember me
          </label>

          {mode === 'signIn' && (
            <button
              type="button"
              className="login-forgot"
              onClick={handleForgotPassword}
            >
              Forgot password?
            </button>
          )}
        </div>

        {error && (
          <div className="login-error">
            {error}
          </div>
        )}

        {info && (
          <div className="login-info">
            {info}
          </div>
        )}

        <button
          type="submit"
          className="login-submit"
          disabled={submitting}
        >
          {submitting
            ? mode === 'signIn'
              ? 'Signing in\u2026'
              : 'Creating account\u2026'
            : mode === 'signIn'
            ? 'Sign in'
            : 'Create account'}
        </button>

        <div className="login-switch">
          {mode === 'signIn' ? (
            <>
              Don't have an account?{' '}
              <button
                type="button"
                onClick={() =>
                  switchMode('signUp')
                }
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() =>
                  switchMode('signIn')
                }
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''

  for (let i = 0; i < 6; i++) {
    result +=
      chars[
        Math.floor(Math.random() * chars.length)
      ]
  }

  return result
}

function OrgGateScreen({ userId, onDone }) {
  const [mode, setMode] = useState('create') // 'create' | 'join'
  const [orgName, setOrgName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(
    false
  )

  const switchMode = (nextMode) => {
    setMode(nextMode)
    setError(null)
  }

  const handleCreate = async (event) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const inviteCode = generateInviteCode()

    const { data: org, error: orgError } =
      await supabase
        .from('organizations')
        .insert({
          name: orgName.trim(),
          invite_code: inviteCode,
        })
        .select()
        .single()

    if (orgError) {
      setSubmitting(false)
      setError(orgError.message)
      return
    }

    const { error: memberError } =
      await supabase.from('memberships').insert({
        org_id: org.id,
        user_id: userId,
        role: 'admin',
      })

    setSubmitting(false)

    if (memberError) {
      setError(memberError.message)
      return
    }

    onDone()
  }

  const handleJoin = async (event) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const { data: org, error: orgError } =
      await supabase
        .from('organizations')
        .select('*')
        .eq(
          'invite_code',
          code.trim().toUpperCase()
        )
        .maybeSingle()

    if (orgError || !org) {
      setSubmitting(false)

      setError(
        'No organization found with that code.'
      )

      return
    }

    const { error: memberError } =
      await supabase.from('memberships').insert({
        org_id: org.id,
        user_id: userId,
        role: 'user',
      })

    setSubmitting(false)

    if (memberError) {
      setError(memberError.message)
      return
    }

    onDone()
  }

  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={
          mode === 'create'
            ? handleCreate
            : handleJoin
        }
      >
        <div className="login-brand">
          Car Finder
        </div>

        <div className="login-subtitle">
          {mode === 'create'
            ? 'Create your organization'
            : 'Join an organization'}
        </div>

        {mode === 'create' ? (
          <>
            <label className="login-label">
              Organization name
            </label>

            <input
              type="text"
              value={orgName}
              onChange={(event) =>
                setOrgName(event.target.value)
              }
              className="login-input"
              autoFocus
              required
            />
          </>
        ) : (
          <>
            <label className="login-label">
              Invite code
            </label>

            <input
              type="text"
              value={code}
              onChange={(event) =>
                setCode(event.target.value)
              }
              className="login-input"
              placeholder="e.g. ZK4F2A"
              autoFocus
              required
            />
          </>
        )}

        {error && (
          <div className="login-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="login-submit"
          disabled={submitting}
        >
          {submitting
            ? 'Please wait\u2026'
            : mode === 'create'
            ? 'Create organization'
            : 'Join organization'}
        </button>

        <div className="login-switch">
          {mode === 'create' ? (
            <>
              Have an invite code?{' '}
              <button
                type="button"
                onClick={() =>
                  switchMode('join')
                }
              >
                Join instead
              </button>
            </>
          ) : (
            <>
              Starting fresh?{' '}
              <button
                type="button"
                onClick={() =>
                  switchMode('create')
                }
              >
                Create one instead
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}

function SettingsPanel({
  organization,
  membership,
  userId,
  onClose,
  onLeft,
}) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteSent, setInviteSent] = useState(false)
  const [inviting, setInviting] = useState(false)

  const isAdmin = membership.role === 'admin'

  const loadMembers = async () => {
    setLoading(true)

    const { data: membershipRows, error: loadError } =
      await supabase
        .from('memberships')
        .select('*')
        .eq('org_id', organization.id)
        .order('created_at')

    if (loadError) {
      setError(loadError.message)
      setLoading(false)
      return
    }

    const userIds = (membershipRows || []).map(
      (item) => item.user_id
    )

    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, username, email')
      .in('id', userIds)

    const nameById = {}

    ;(profileRows || []).forEach((profile) => {
      nameById[profile.id] =
        profile.username || profile.email
    })

    const merged = (membershipRows || []).map(
      (item) => ({
        ...item,
        displayName:
          nameById[item.user_id] || 'Unknown',
      })
    )

    setMembers(merged)
    setLoading(false)
  }

  useEffect(() => {
    loadMembers()
  }, [])

  const handleRoleChange = async (
    membershipId,
    newRole
  ) => {
    setError(null)

    const { error: updateError } =
      await supabase
        .from('memberships')
        .update({ role: newRole })
        .eq('id', membershipId)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setMembers((current) =>
      current.map((item) =>
        item.id === membershipId
          ? { ...item, role: newRole }
          : item
      )
    )
  }

  const copyInviteCode = async () => {
    try {
      await navigator.clipboard.writeText(
        organization.invite_code
      )

      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      // Clipboard access can fail; the code is
      // still visible on screen to copy by hand.
    }
  }

  const handleInviteByEmail = async (event) => {
    event.preventDefault()

    setError(null)
    setInviteSent(false)

    const cleanEmail = inviteEmail
      .trim()
      .toLowerCase()

    if (!cleanEmail) {
      return
    }

    setInviting(true)

    const { error: inviteError } = await supabase
      .from('org_invites')
      .insert({
        org_id: organization.id,
        email: cleanEmail,
        invited_by: userId,
      })

    if (inviteError) {
      setInviting(false)

      setError(
        inviteError.message.includes('duplicate')
          ? 'That email already has a pending invite.'
          : inviteError.message
      )

      return
    }

    const { error: otpError } =
      await supabase.auth.signInWithOtp({
        email: cleanEmail,
      })

    setInviting(false)

    if (otpError) {
      setError(otpError.message)
      return
    }

    setInviteEmail('')
    setInviteSent(true)
  }

  const handleLeaveOrg = async () => {
    setError(null)

    if (isAdmin) {
      const otherAdmins = members.some(
        (item) =>
          item.user_id !== userId &&
          item.role === 'admin'
      )

      if (!otherAdmins) {
        setError(
          "You're the only admin here. Promote someone else to admin before leaving."
        )
        return
      }
    }

    const confirmed = window.confirm(
      `Leave ${organization.name}? You'll need an invite code to rejoin.`
    )

    if (!confirmed) {
      return
    }

    const { error: leaveError } = await supabase
      .from('memberships')
      .delete()
      .eq('id', membership.id)

    if (leaveError) {
      setError(leaveError.message)
      return
    }

    onLeft()
  }

  return (
    <div
      className="settings-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="settings-modal"
        onClick={(event) =>
          event.stopPropagation()
        }
      >
        <div className="inspector-header">
          <div>
            <span className="inspector-eyebrow">
              SETTINGS
            </span>

            <h2>{organization.name}</h2>
          </div>

          <button
            className="close-button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {isAdmin && (
          <div className="detail-group">
            <label>INVITE CODE</label>

            <div className="invite-code-row">
              <div className="invite-code-value">
                {organization.invite_code}
              </div>

              <button
                type="button"
                className="invite-action-button"
                onClick={copyInviteCode}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div className="field-hint">
              Share this code with people you want
              to invite. They enter it on the
              "Join an organization" screen.
            </div>
          </div>
        )}

        {isAdmin && (
          <form
            className="detail-group"
            onSubmit={handleInviteByEmail}
          >
            <label>INVITE BY EMAIL</label>

            <div className="invite-code-row">
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) =>
                  setInviteEmail(
                    event.target.value
                  )
                }
                placeholder="name@example.com"
                className="login-input"
                style={{ marginBottom: 0 }}
              />

              <button
                type="submit"
                className="invite-action-button invite-action-primary"
                disabled={inviting}
              >
                {inviting
                  ? 'Sending\u2026'
                  : 'Send invite'}
              </button>
            </div>

            {inviteSent && (
              <div className="login-info">
                Invite sent. They'll be
                added to this organization
                automatically the first time
                they sign in.
              </div>
            )}

            <div className="field-hint">
              We'll email them a sign-in
              link. No account needed yet, one
              will be created for them.
            </div>
          </form>
        )}

        <div className="detail-group">
          <label>MEMBERS</label>

          {loading ? (
            <div className="field-hint">
              Loading\u2026
            </div>
          ) : (
            <div className="member-list">
              {members.map((item) => (
                <div
                  key={item.id}
                  className="member-row"
                >
                  <span className="member-email">
                    {item.displayName}
                  </span>

                  {isAdmin ? (
                    <select
                      value={item.role}
                      onChange={(event) =>
                        handleRoleChange(
                          item.id,
                          event.target.value
                        )
                      }
                      className="member-role-select"
                    >
                      <option value="admin">
                        Admin
                      </option>

                      <option value="user">
                        User
                      </option>
                    </select>
                  ) : (
                    <span className="member-role-label">
                      {item.role === 'admin'
                        ? 'Admin'
                        : 'User'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="login-error">
            {error}
          </div>
        )}

        <div className="settings-footer">
          <button
            className="settings-leave"
            onClick={handleLeaveOrg}
          >
            Leave organization
          </button>

          <button
            className="add-car-button"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function App() {
  const canvasRef = useRef(null)
  const justFinishedSelecting = useRef(false)
  const justFinishedDraggingSpace = useRef(false)
  const spaceDragMovedRef = useRef(false)
  const selectionMovedRef = useRef(false)
  const selectionStartRef = useRef(null)
  const areaDrawStartRef = useRef(null)
  const roadDrawStartRef = useRef(null)
  const pinchRef = useRef(null)
  const zoomRef = useRef(1)
  const zoomOriginRef = useRef({ x: 0, y: 0 })
  const panRef = useRef({ x: 0, y: 0 })

  const [spaces, setSpaces] = useState(initialSpaces)
  const [vehicles, setVehicles] = useState(initialVehicles)
  const [areas, setAreas] = useState([])
  const [roads, setRoads] = useState([])

  const [activeTool, setActiveTool] = useState('select')

  const [selectedSpace, setSelectedSpace] = useState(null)
  const [selectedVehicle, setSelectedVehicle] = useState(null)
  const [selectedSpaces, setSelectedSpaces] = useState([])
  const [selectedArea, setSelectedArea] = useState(null)
  const [selectedRoad, setSelectedRoad] = useState(null)
  const [labels, setLabels] = useState([])
  const [selectedLabel, setSelectedLabel] = useState(null)
  const [draggingLabel, setDraggingLabel] = useState(null)
  const [customObjects, setCustomObjects] = useState([])
  const [selectedCustomObject, setSelectedCustomObject] = useState(null)
  const [drawingCustomObject, setDrawingCustomObject] = useState(null)
  const [customObjectPreviewPos, setCustomObjectPreviewPos] = useState(null)
  const [draggingCustomObject, setDraggingCustomObject] = useState(null)
  const [draggingVertex, setDraggingVertex] = useState(null)

  const [lots, setLots] = useState([
    { id: 1, name: 'Main Yard' },
  ])

  const [activeLotId, setActiveLotId] = useState(1)

  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        const remembered = localStorage.getItem(
          REMEMBER_ME_KEY
        )

        if (
          data.session &&
          remembered === 'false'
        ) {
          supabase.auth.signOut()
          setSession(null)
        } else {
          setSession(data.session)
        }

        setAuthLoading(false)
      })

    const {
      data: authListener,
    } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession)
      }
    )

    return () => {
      authListener.subscription.unsubscribe()
    }
  }, [])

  const [membership, setMembership] = useState(null)
  const [organization, setOrganization] = useState(null)
  const [orgLoading, setOrgLoading] = useState(true)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
  const [mapDataLoaded, setMapDataLoaded] = useState(false)

  useEffect(() => {
    if (!organization) {
      setMapDataLoaded(false)
      return
    }

    const loadMapData = async () => {
      setMapDataLoaded(false)

      const [
        lotsRes,
        spacesRes,
        vehiclesRes,
        areasRes,
        roadsRes,
        labelsRes,
        customRes,
      ] = await Promise.all([
        supabase
          .from('lots')
          .select('*')
          .eq('org_id', organization.id),
        supabase
          .from('spaces')
          .select('*')
          .eq('org_id', organization.id),
        supabase
          .from('vehicles')
          .select('*')
          .eq('org_id', organization.id),
        supabase
          .from('map_areas')
          .select('*')
          .eq('org_id', organization.id),
        supabase
          .from('map_roads')
          .select('*')
          .eq('org_id', organization.id),
        supabase
          .from('map_labels')
          .select('*')
          .eq('org_id', organization.id),
        supabase
          .from('map_custom_objects')
          .select('*')
          .eq('org_id', organization.id),
      ])

      if (
        lotsRes.data &&
        lotsRes.data.length > 0
      ) {
        setLots(
          lotsRes.data.map((lot) => ({
            id: lot.id,
            name: lot.name,
          }))
        )

        setActiveLotId(lotsRes.data[0].id)

        setSpaces(
          (spacesRes.data || []).map(
            (space) => ({
              id: space.id,
              x: space.x,
              y: space.y,
              label: space.label,
              rotation: space.rotation,
              lotId: space.lot_id,
            })
          )
        )
      } else {
        const defaultLot = {
          id: Date.now(),
          name: 'Main Yard',
        }

        setLots([defaultLot])
        setActiveLotId(defaultLot.id)

        setSpaces(
          initialSpaces.map(
            (space, index) => ({
              ...space,
              id: Date.now() + index + 1,
              lotId: defaultLot.id,
            })
          )
        )
      }

      setVehicles(
        (vehiclesRes.data || []).map(
          (vehicle) => ({
            id: vehicle.id,
            registration:
              vehicle.registration,
            vin: vehicle.vin,
            make: vehicle.make,
            status: vehicle.status,
            spaceId: vehicle.space_id,
          })
        )
      )

      setAreas(
        (areasRes.data || []).map(
          (area) => ({
            id: area.id,
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height,
            label: area.label,
            color: area.color,
            lotId: area.lot_id,
          })
        )
      )

      setRoads(
        computeGroupsPerLot(
          (roadsRes.data || []).map(
            (road) => ({
              id: road.id,
              x: road.x,
              y: road.y,
              width: road.width,
              height: road.height,
              lotId: road.lot_id,
            })
          )
        )
      )

      setLabels(
        (labelsRes.data || []).map(
          (label) => ({
            id: label.id,
            x: label.x,
            y: label.y,
            width: label.width,
            height: label.height,
            text: label.text,
            lotId: label.lot_id,
          })
        )
      )

      setCustomObjects(
        (customRes.data || []).map(
          (obj) => ({
            id: obj.id,
            label: obj.label,
            color: obj.color,
            points: obj.points,
            lotId: obj.lot_id,
          })
        )
      )

      setMapDataLoaded(true)
    }

    loadMapData()
  }, [organization])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('lots')
        .delete()
        .eq('org_id', organization.id)

      if (lots.length > 0) {
        await supabase.from('lots').insert(
          lots.map((lot) => ({
            id: lot.id,
            org_id: organization.id,
            name: lot.name,
          }))
        )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [lots, organization, mapDataLoaded])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('spaces')
        .delete()
        .eq('org_id', organization.id)

      if (spaces.length > 0) {
        await supabase.from('spaces').insert(
          spaces.map((space) => ({
            id: space.id,
            org_id: organization.id,
            lot_id: space.lotId,
            x: space.x,
            y: space.y,
            label: space.label,
            rotation: space.rotation,
          }))
        )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [spaces, organization, mapDataLoaded])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('vehicles')
        .delete()
        .eq('org_id', organization.id)

      if (vehicles.length > 0) {
        await supabase
          .from('vehicles')
          .insert(
            vehicles.map((vehicle) => ({
              id: vehicle.id,
              org_id: organization.id,
              registration:
                vehicle.registration,
              vin: vehicle.vin,
              make: vehicle.make,
              status: vehicle.status,
              space_id: vehicle.spaceId,
            }))
          )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [vehicles, organization, mapDataLoaded])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('map_areas')
        .delete()
        .eq('org_id', organization.id)

      if (areas.length > 0) {
        await supabase
          .from('map_areas')
          .insert(
            areas.map((area) => ({
              id: area.id,
              org_id: organization.id,
              lot_id: area.lotId,
              x: area.x,
              y: area.y,
              width: area.width,
              height: area.height,
              label: area.label,
              color: area.color,
            }))
          )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [areas, organization, mapDataLoaded])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('map_roads')
        .delete()
        .eq('org_id', organization.id)

      if (roads.length > 0) {
        await supabase
          .from('map_roads')
          .insert(
            roads.map((road) => ({
              id: road.id,
              org_id: organization.id,
              lot_id: road.lotId,
              x: road.x,
              y: road.y,
              width: road.width,
              height: road.height,
            }))
          )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [roads, organization, mapDataLoaded])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('map_labels')
        .delete()
        .eq('org_id', organization.id)

      if (labels.length > 0) {
        await supabase
          .from('map_labels')
          .insert(
            labels.map((label) => ({
              id: label.id,
              org_id: organization.id,
              lot_id: label.lotId,
              x: label.x,
              y: label.y,
              width: label.width,
              height: label.height,
              text: label.text,
            }))
          )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [labels, organization, mapDataLoaded])

  useEffect(() => {
    if (!organization || !mapDataLoaded) {
      return
    }

    const timeout = setTimeout(async () => {
      await supabase
        .from('map_custom_objects')
        .delete()
        .eq('org_id', organization.id)

      if (customObjects.length > 0) {
        await supabase
          .from('map_custom_objects')
          .insert(
            customObjects.map((obj) => ({
              id: obj.id,
              org_id: organization.id,
              lot_id: obj.lotId,
              label: obj.label,
              color: obj.color,
              points: obj.points,
            }))
          )
      }
    }, 800)

    return () => clearTimeout(timeout)
  }, [
    customObjects,
    organization,
    mapDataLoaded,
  ])

  const loadMembership = async (userId) => {
    setOrgLoading(true)

    const { data } = await supabase
      .from('memberships')
      .select('*, organizations(*)')
      .eq('user_id', userId)
      .maybeSingle()

    if (data) {
      setMembership(data)
      setOrganization(data.organizations)
      setOrgLoading(false)
      return
    }

    const userEmail =
      session && session.user
        ? session.user.email
        : null

    if (userEmail) {
      const { data: invite } = await supabase
        .from('org_invites')
        .select('*')
        .eq('email', userEmail)
        .maybeSingle()

      if (invite) {
        await supabase
          .from('memberships')
          .insert({
            org_id: invite.org_id,
            user_id: userId,
            role: 'user',
          })

        await supabase
          .from('org_invites')
          .delete()
          .eq('id', invite.id)

        const { data: retry } = await supabase
          .from('memberships')
          .select('*, organizations(*)')
          .eq('user_id', userId)
          .maybeSingle()

        if (retry) {
          setMembership(retry)
          setOrganization(retry.organizations)
          setOrgLoading(false)
          return
        }
      }
    }

    setMembership(null)
    setOrganization(null)
    setOrgLoading(false)
  }

  useEffect(() => {
    if (!session) {
      setMembership(null)
      setOrganization(null)
      setOrgLoading(false)
      return
    }

    loadMembership(session.user.id)
  }, [session])

  const [renamingLotId, setRenamingLotId] = useState(null)
  const [showStatusLegend, setShowStatusLegend] = useState(false)
  const [clipboard, setClipboard] = useState(null)
  const [isRenamingSpace, setIsRenamingSpace] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [recentSearches, setRecentSearches] = useState([])
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const [highlightSpaceId, setHighlightSpaceId] = useState(null)
  const [showToolsPanel, setShowToolsPanel] = useState(false)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])

  const [draggingSpace, setDraggingSpace] = useState(null)
  const [draggingVehicle, setDraggingVehicle] = useState(null)
  const [draggingArea, setDraggingArea] = useState(null)
  const [resizingArea, setResizingArea] = useState(null)
  const [resizingRoad, setResizingRoad] = useState(null)
  const [resizingLabel, setResizingLabel] = useState(null)
  const [draggingRoad, setDraggingRoad] = useState(null)

  const [selectionBox, setSelectionBox] = useState(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const [drawingArea, setDrawingArea] = useState(null)
  const [drawingRoad, setDrawingRoad] = useState(null)

  const [previewPosition, setPreviewPosition] = useState(null)
  const [snapTarget, setSnapTarget] = useState(null)
  const [isOverUnassignedZone, setIsOverUnassignedZone] = useState(false)

  const [zoom, setZoom] = useState(0.4)
  const [zoomOrigin, setZoomOrigin] = useState({
    x: 0,
    y: 0,
  })

  const [pan, setPan] = useState({
    x: 0,
    y: 0,
  })

  const [showAddCar, setShowAddCar] = useState(false)
  const [addCarAnchor, setAddCarAnchor] = useState(null)
  const addCarButtonRef = useRef(null)

  const emptyCarRow = (status) => ({
    id: Math.random(),
    registration: '',
    vin: '',
    make: '',
    status: status || 'ready',
  })

  const [newCarRows, setNewCarRows] = useState([
    emptyCarRow('ready'),
  ])

  const [newCarStatus, setNewCarStatus] = useState('ready')
  const [spaceAddCount, setSpaceAddCount] = useState(1)

  const clampZoom = (value) => {
    return Math.min(2, Math.max(0.4, value))
  }

  // The zoom percentage shown to the user is relative to this value,
  // not the raw internal scale, so the comfortable default zoom
  // level reads as "100%" instead of an arbitrary number like "40%".
  const ZOOM_DISPLAY_REFERENCE = 0.4

  const setZoomOriginAtPoint = (x, y) => {
    zoomOriginRef.current = { x, y }

    setZoomOrigin({ x, y })
  }

  const zoomAroundPoint = (newZoom, x, y) => {
    const canvasEl = canvasRef.current

    if (!canvasEl) {
      return
    }

    const rect = canvasEl.getBoundingClientRect()

    const pointX = x ?? rect.width / 2
    const pointY = y ?? rect.height / 2

    const oldZoom = zoomRef.current
    const nextZoom = clampZoom(Number(newZoom.toFixed(3)))

    const currentPan = panRef.current

    const worldX =
      (pointX - currentPan.x) / oldZoom

    const worldY =
      (pointY - currentPan.y) / oldZoom

    const nextPan = {
      x: pointX - worldX * nextZoom,
      y: pointY - worldY * nextZoom,
    }

    panRef.current = nextPan

    setPan(nextPan)

    zoomOriginRef.current = {
      x: 0,
      y: 0,
    }

    setZoomOrigin({
      x: 0,
      y: 0,
    })

    setZoom(nextZoom)
  }

  const zoomBy = (delta) => {
    zoomAroundPoint(zoom + delta)
  }

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    const canvasEl = canvasRef.current

    if (!canvasEl) {
      return
    }

    const handleWheel = (event) => {
      event.preventDefault()

      if (event.ctrlKey || event.metaKey) {
        const rect = canvasEl.getBoundingClientRect()

        const mouseX = event.clientX - rect.left
        const mouseY = event.clientY - rect.top

        const delta = -event.deltaY * 0.01

        zoomAroundPoint(
          zoomRef.current + delta,
          mouseX,
          mouseY
        )

        return
      }

      const nextPan = {
        x: panRef.current.x - event.deltaX,
        y: panRef.current.y - event.deltaY,
      }

      panRef.current = nextPan

      setPan(nextPan)
    }

    const getTouchDistance = (touches) => {
      const dx =
        touches[0].clientX -
        touches[1].clientX

      const dy =
        touches[0].clientY -
        touches[1].clientY

      return Math.sqrt(dx * dx + dy * dy)
    }

    const getTouchMidpoint = (touches) => {
      const rect = canvasEl.getBoundingClientRect()

      return {
        x:
          (touches[0].clientX +
            touches[1].clientX) /
            2 -
          rect.left,

        y:
          (touches[0].clientY +
            touches[1].clientY) /
            2 -
          rect.top,
      }
    }

    const handleTouchStart = (event) => {
      if (event.touches.length === 2) {
        const midpoint = getTouchMidpoint(event.touches)

        setZoomOriginAtPoint(
          midpoint.x,
          midpoint.y
        )

        pinchRef.current = {
          distance: getTouchDistance(event.touches),
          zoomStart: zoomRef.current,
          originX: midpoint.x,
          originY: midpoint.y,
        }
      }
    }

    const handleTouchMove = (event) => {
      if (
        event.touches.length === 2 &&
        pinchRef.current
      ) {
        event.preventDefault()

        const newDistance = getTouchDistance(event.touches)

        const ratio =
          newDistance /
          pinchRef.current.distance

        const midpoint = getTouchMidpoint(event.touches)

        zoomAroundPoint(
          pinchRef.current.zoomStart * ratio,
          midpoint.x,
          midpoint.y
        )
      }
    }

    const handleTouchEnd = (event) => {
      if (event.touches.length < 2) {
        pinchRef.current = null
      }
    }

    canvasEl.addEventListener(
      'wheel',
      handleWheel,
      { passive: false }
    )

    canvasEl.addEventListener(
      'touchstart',
      handleTouchStart,
      { passive: false }
    )

    canvasEl.addEventListener(
      'touchmove',
      handleTouchMove,
      { passive: false }
    )

    canvasEl.addEventListener(
      'touchend',
      handleTouchEnd
    )

    canvasEl.addEventListener(
      'touchcancel',
      handleTouchEnd
    )

    return () => {
      canvasEl.removeEventListener(
        'wheel',
        handleWheel
      )

      canvasEl.removeEventListener(
        'touchstart',
        handleTouchStart
      )

      canvasEl.removeEventListener(
        'touchmove',
        handleTouchMove
      )

      canvasEl.removeEventListener(
        'touchend',
        handleTouchEnd
      )

      canvasEl.removeEventListener(
        'touchcancel',
        handleTouchEnd
      )
    }
  }, [session, membership])

  const getMousePosition = (event) => {
    const rect =
      canvasRef.current.getBoundingClientRect()

    const screenX =
      event.clientX - rect.left

    const screenY =
      event.clientY - rect.top

    const currentPan = panRef.current
    const currentZoom = zoomRef.current

    return {
      x:
        (screenX - currentPan.x) /
        currentZoom,

      y:
        (screenY - currentPan.y) /
        currentZoom,
    }
  }

  const snapToGrid = (value) => {
    return (
      Math.round(value / GRID_SIZE) *
      GRID_SIZE
    )
  }

  const pushHistory = () => {
    setPast((current) =>
      [
        ...current,
        {
          spaces,
          areas,
          roads,
          labels,
          customObjects,
          vehicles,
          lots,
        },
      ].slice(-50)
    )

    setFuture([])
  }

  const undo = () => {
    if (past.length === 0) {
      return
    }

    const previous = past[past.length - 1]

    setFuture((current) =>
      [
        {
          spaces,
          areas,
          roads,
          labels,
          customObjects,
          vehicles,
          lots,
        },
        ...current,
      ].slice(0, 50)
    )

    setPast((current) =>
      current.slice(0, -1)
    )

    setSpaces(previous.spaces)
    setAreas(previous.areas)
    setRoads(previous.roads || [])
    setLabels(previous.labels || [])
    setCustomObjects(
      previous.customObjects || []
    )
    setVehicles(previous.vehicles)

    const restoredLots =
      previous.lots || [
        { id: 1, name: 'Main Yard' },
      ]

    setLots(restoredLots)

    if (
      !restoredLots.some(
        (lot) => lot.id === activeLotId
      )
    ) {
      setActiveLotId(restoredLots[0].id)
    }

    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedRoad(null)
    setSelectedLabel(null)
    setSelectedCustomObject(null)
    setSelectedVehicle(null)
    setSelectedSpaces([])
    setIsRenamingSpace(false)
    setShowAddCar(false)
  }

  const redo = () => {
    if (future.length === 0) {
      return
    }

    const next = future[0]

    setPast((current) =>
      [
        ...current,
        {
          spaces,
          areas,
          roads,
          labels,
          customObjects,
          vehicles,
          lots,
        },
      ].slice(-50)
    )

    setFuture((current) =>
      current.slice(1)
    )

    setSpaces(next.spaces)
    setAreas(next.areas)
    setRoads(next.roads || [])
    setLabels(next.labels || [])
    setCustomObjects(
      next.customObjects || []
    )
    setVehicles(next.vehicles)

    const restoredLotsRedo =
      next.lots || [
        { id: 1, name: 'Main Yard' },
      ]

    setLots(restoredLotsRedo)

    if (
      !restoredLotsRedo.some(
        (lot) => lot.id === activeLotId
      )
    ) {
      setActiveLotId(restoredLotsRedo[0].id)
    }

    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedRoad(null)
    setSelectedLabel(null)
    setSelectedCustomObject(null)
    setSelectedVehicle(null)
    setSelectedSpaces([])
    setIsRenamingSpace(false)
    setShowAddCar(false)
  }

  const formatVinShort = (vin) => {
    if (!vin) {
      return null
    }

    return `VIN: ${vin.slice(-6)}`
  }

  const formatVinBare = (vin) => {
    if (!vin) {
      return null
    }

    return vin.slice(-6)
  }

  const closeInspector = () => {
    setSelectedVehicle(null)
    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedRoad(null)
    setSelectedLabel(null)
    setSelectedCustomObject(null)
    setShowAddCar(false)
    setIsRenamingSpace(false)
    setHighlightSpaceId(null)
  }

  const handleCanvasMouseDown = (event) => {
    if (event.button !== 0) {
      return
    }

    if (
      event.target.closest('.parking-space') ||
      event.target.closest('.car') ||
      event.target.closest('.map-area') ||
      event.target.closest('.map-road') ||
      event.target.closest('.map-label') ||
      event.target.closest('.custom-object-layer') ||
      event.target.closest('.zoom-controls') ||
      event.target.closest('.status-legend') ||
      event.target.closest('.canvas-status') ||
      event.target.closest('.yard-title')
    ) {
      return
    }

    const position = getMousePosition(event)

    setSelectedVehicle(null)
    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedRoad(null)
    setSelectedLabel(null)
    setSelectedCustomObject(null)
    setShowAddCar(false)

    if (activeTool === 'customObject') {
      if (!drawingCustomObject) {
        pushHistory()

        setDrawingCustomObject({
          points: [position],
        })

        setCustomObjectPreviewPos(position)

        return
      }

      const firstPoint =
        drawingCustomObject.points[0]

      const distToFirst = Math.hypot(
        position.x - firstPoint.x,
        position.y - firstPoint.y
      )

      const CLOSE_THRESHOLD = 18

      if (
        drawingCustomObject.points.length >=
          3 &&
        distToFirst <= CLOSE_THRESHOLD
      ) {
        const newObject = {
          id: Date.now(),
          label:
            'Object ' +
            (customObjects.length + 1),
          color: OBJECT_COLORS[0],
          points: drawingCustomObject.points,
          lotId: activeLotId,
        }

        setCustomObjects((current) => [
          ...current,
          newObject,
        ])

        setDrawingCustomObject(null)
        setCustomObjectPreviewPos(null)
        setSelectedCustomObject(newObject.id)

        return
      }

      setDrawingCustomObject((current) => ({
        points: [
          ...current.points,
          position,
        ],
      }))

      return
    }

    if (activeTool === 'area') {
      pushHistory()

      areaDrawStartRef.current = position

      setDrawingArea({
        startX: position.x,
        startY: position.y,
        endX: position.x,
        endY: position.y,
      })

      return
    }

    if (activeTool === 'road') {
      pushHistory()

      roadDrawStartRef.current = position

      setDrawingRoad({
        startX: position.x,
        startY: position.y,
        endX: position.x,
        endY: position.y,
      })

      return
    }

    if (activeTool === 'label') {
      pushHistory()

      const newLabel = {
        id: Date.now(),
        x: snapToGrid(position.x - 40),
        y: snapToGrid(position.y - 15),
        width: 84,
        height: 32,
        text: 'Label',
        lotId: activeLotId,
      }

      setLabels((current) => [
        ...current,
        newLabel,
      ])

      setSelectedLabel(newLabel.id)
      setActiveTool('select')

      return
    }

    setIsSelecting(true)

    selectionMovedRef.current = false

    selectionStartRef.current = position

    setSelectionBox({
      startX: position.x,
      startY: position.y,
      endX: position.x,
      endY: position.y,
    })
  }

  const handleCanvasClick = (event) => {
    if (
      event.target.closest('.parking-space') ||
      event.target.closest('.car') ||
      event.target.closest('.map-area') ||
      event.target.closest('.map-road') ||
      event.target.closest('.map-label') ||
      event.target.closest('.custom-object-layer') ||
      event.target.closest('.zoom-controls') ||
      event.target.closest('.status-legend') ||
      event.target.closest('.canvas-status') ||
      event.target.closest('.yard-title')
    ) {
      return
    }

    if (justFinishedSelecting.current) {
      justFinishedSelecting.current = false
      return
    }

    closeInspector()
    setSelectedSpaces([])
  }

  const addSpace = (count) => {
    const total = count || 1

    pushHistory()

    const canvasEl = canvasRef.current

    let originX = 84
    let originY = 112

    if (canvasEl) {
      const rect =
        canvasEl.getBoundingClientRect()

      const currentZoom = zoomRef.current
      const currentPan = panRef.current

      const centerScreenX = rect.width / 2
      const centerScreenY = rect.height / 2

      const columnsInRow = Math.min(total, 5)

      const centerWorldX =
        (centerScreenX - currentPan.x) /
        currentZoom

      const centerWorldY =
        (centerScreenY - currentPan.y) /
        currentZoom

      originX = snapToGrid(
        centerWorldX -
          (columnsInRow * SPACE_WIDTH) / 2
      )

      originY = snapToGrid(
        centerWorldY - SPACE_HEIGHT / 2
      )
    }

    setSpaces((current) => {
      const lotSpaces = current.filter(
        (space) => space.lotId === activeLotId
      )

      const occupied = lotSpaces.map(
        (space) => ({ x: space.x, y: space.y })
      )

      const spacesOverlap = (
        ax,
        ay,
        bx,
        by
      ) => {
        return (
          ax < bx + SPACE_WIDTH &&
          ax + SPACE_WIDTH > bx &&
          ay < by + SPACE_HEIGHT &&
          ay + SPACE_HEIGHT > by
        )
      }

      const newSpaces = []
      const spacesInLot = lotSpaces.length

      let searchIndex = 0

      for (let i = 0; i < total; i++) {
        const number = spacesInLot + i + 1

        let placedX = originX
        let placedY = originY
        let safety = 0

        while (safety < 5000) {
          const column = searchIndex % 5
          const row = Math.floor(
            searchIndex / 5
          )

          const candidateX =
            originX + column * SPACE_WIDTH

          const candidateY =
            originY + row * SPACE_HEIGHT

          const overlaps = occupied.some(
            (item) =>
              spacesOverlap(
                candidateX,
                candidateY,
                item.x,
                item.y
              )
          )

          searchIndex++
          safety++

          if (!overlaps) {
            placedX = candidateX
            placedY = candidateY
            break
          }
        }

        newSpaces.push({
          id: Date.now() + i,
          x: placedX,
          y: placedY,

          label:
            String(number).padStart(2, '0'),

          rotation: 0,
          lotId: activeLotId,
        })

        occupied.push({
          x: placedX,
          y: placedY,
        })
      }

      return [...current, ...newSpaces]
    })
  }

  const addCarRow = () => {
    setNewCarRows((current) => [
      ...current,
      emptyCarRow(newCarStatus),
    ])
  }

  const removeCarRow = (rowId) => {
    setNewCarRows((current) => {
      if (current.length <= 1) {
        return current
      }

      return current.filter(
        (row) => row.id !== rowId
      )
    })
  }

  const updateCarRow = (
    rowId,
    field,
    value
  ) => {
    setNewCarRows((current) => {
      return current.map((row) => {
        if (row.id === rowId) {
          return {
            ...row,
            [field]: value,
          }
        }

        return row
      })
    })
  }

  const addNewCar = () => {
    const filledRows = newCarRows.filter(
      (row) =>
        row.registration.trim() ||
        row.vin.trim() ||
        row.make.trim()
    )

    if (filledRows.length === 0) {
      return
    }

    pushHistory()

    const newVehicles = filledRows.map(
      (row, index) => ({
        id: Date.now() + index,

        registration: row.registration
          .trim()
          .toUpperCase(),

        vin: row.vin
          .trim()
          .toUpperCase(),

        make: row.make.trim(),

        status: row.status,

        spaceId: null,
      })
    )

    setVehicles((current) => [
      ...current,
      ...newVehicles,
    ])

    setNewCarRows([emptyCarRow('ready')])
    setNewCarStatus('ready')

    setShowAddCar(false)

    setSelectedVehicle(
      newVehicles[newVehicles.length - 1].id
    )

    setSelectedSpace(null)
    setSelectedSpaces([])
  }

  const updateVehicleStatus = (event) => {
    const newStatus = event.target.value

    if (!selectedVehicle) {
      return
    }

    pushHistory()

    setVehicles((current) => {
      return current.map((vehicle) => {
        if (vehicle.id === selectedVehicle) {
          return {
            ...vehicle,
            status: newStatus,
          }
        }

        return vehicle
      })
    })
  }

  const moveVehicleToUnassigned = () => {
    if (!selectedVehicle) {
      return
    }

    pushHistory()

    setVehicles((current) => {
      return current.map((vehicle) => {
        if (vehicle.id === selectedVehicle) {
          return {
            ...vehicle,
            spaceId: null,
          }
        }

        return vehicle
      })
    })

    setSelectedVehicle(null)
    setSelectedSpace(null)
    setSelectedSpaces([])
  }

  const deleteVehicle = () => {
    if (!selectedVehicle) {
      return
    }

    pushHistory()

    setVehicles((current) => {
      return current.filter(
        (vehicle) =>
          vehicle.id !== selectedVehicle
      )
    })

    setSelectedVehicle(null)
    setSelectedSpace(null)
    setSelectedSpaces([])
  }

  const toggleEditMode = () => {
    setShowToolsPanel((current) => {
      if (current) {
        setActiveTool('select')
      }

      return !current
    })
  }

  const addLot = () => {
    pushHistory()

    const newLot = {
      id: Date.now(),
      name: 'Lot ' + (lots.length + 1),
    }

    setLots((current) => [
      ...current,
      newLot,
    ])

    setActiveLotId(newLot.id)
    setPan({ x: 0, y: 0 })
    panRef.current = { x: 0, y: 0 }
    setZoom(ZOOM_DISPLAY_REFERENCE)
    zoomRef.current = ZOOM_DISPLAY_REFERENCE
    closeInspector()
    setSelectedSpaces([])
    setRenamingLotId(newLot.id)
  }

  const switchLot = (lotId) => {
    if (lotId === activeLotId) {
      return
    }

    setActiveLotId(lotId)
    setPan({ x: 0, y: 0 })
    panRef.current = { x: 0, y: 0 }
    setZoom(ZOOM_DISPLAY_REFERENCE)
    zoomRef.current = ZOOM_DISPLAY_REFERENCE
    closeInspector()
    setSelectedSpaces([])
  }

  const renameLot = (event) => {
    const newName = event.target.value

    setLots((current) => {
      return current.map((lot) => {
        if (lot.id === renamingLotId) {
          return {
            ...lot,
            name: newName,
          }
        }

        return lot
      })
    })
  }

  const jumpToVehicle = (vehicle) => {
    setSearchQuery('')
    setShowAddCar(false)
    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedSpaces([])
    setSelectedVehicle(vehicle.id)
    setHighlightSpaceId(null)
    setIsSearchFocused(false)

    setRecentSearches((current) => {
      const withoutThis = current.filter(
        (id) => id !== vehicle.id
      )

      return [
        vehicle.id,
        ...withoutThis,
      ].slice(0, 5)
    })

    if (!vehicle.spaceId) {
      return
    }

    const space = spaces.find(
      (item) => item.id === vehicle.spaceId
    )

    const canvasEl = canvasRef.current

    if (!space || !canvasEl) {
      return
    }

    if (
      space.lotId &&
      space.lotId !== activeLotId
    ) {
      setActiveLotId(space.lotId)
    }

    const rect =
      canvasEl.getBoundingClientRect()

    const centerX =
      space.x + SPACE_WIDTH / 2

    const centerY =
      space.y + SPACE_HEIGHT / 2

    const currentZoom = zoomRef.current

    const newPan = {
      x:
        rect.width / 2 -
        centerX * currentZoom,
      y:
        rect.height / 2 -
        centerY * currentZoom,
    }

    panRef.current = newPan
    setPan(newPan)

    setHighlightSpaceId(space.id)
  }

  const startSpaceDrag = (
    event,
    space
  ) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    spaceDragMovedRef.current = false

    const position =
      getMousePosition(event)

    if (
      selectedSpaces.length > 1 &&
      selectedSpaces.includes(space.id)
    ) {
      const selectedSpaceData =
        spaces
          .filter((item) =>
            selectedSpaces.includes(item.id)
          )
          .map((item) => ({
            id: item.id,
            x: item.x,
            y: item.y,
          }))

      setDraggingSpace({
        id: space.id,

        offsetX:
          position.x - space.x,

        offsetY:
          position.y - space.y,

        multi: true,

        originalSpaces:
          selectedSpaceData,
      })

      setSelectedSpace(null)
    } else {
      setDraggingSpace({
        id: space.id,

        offsetX:
          position.x - space.x,

        offsetY:
          position.y - space.y,

        multi: false,
      })

      setSelectedSpace(null)

      setSelectedSpaces([])
    }

    setSelectedVehicle(null)
    setShowAddCar(false)
  }

  const startVehicleDrag = (
    event,
    vehicle
  ) => {
    event.stopPropagation()

    pushHistory()

    const position =
      getMousePosition(event)

    const space = spaces.find(
      (item) =>
        item.id === vehicle.spaceId
    )

    if (!space) {
      return
    }

    const centerX =
      space.x +
      SPACE_WIDTH / 2

    const centerY =
      space.y +
      SPACE_HEIGHT / 2

    setDraggingVehicle({
      id: vehicle.id,

      offsetX:
        position.x - centerX,

      offsetY:
        position.y - centerY,
    })

    setSelectedVehicle(vehicle.id)

    setSelectedSpace(null)
    setSelectedSpaces([])
    setShowAddCar(false)

    setPreviewPosition({
      x: centerX,
      y: centerY,
    })
  }

  const startUnassignedVehicleDrag = (
    event,
    vehicle
  ) => {
    event.stopPropagation()

    pushHistory()

    const position =
      getMousePosition(event)

    setDraggingVehicle({
      id: vehicle.id,

      offsetX: 0,
      offsetY: 0,

      fromUnassigned: true,
    })

    setSelectedVehicle(vehicle.id)

    setSelectedSpace(null)
    setSelectedSpaces([])
    setShowAddCar(false)

    setPreviewPosition({
      x: position.x,
      y: position.y,
    })
  }

  const handleMouseMove = (event) => {
    const position =
      getMousePosition(event)

    if (drawingCustomObject) {
      setCustomObjectPreviewPos(position)
      return
    }

    if (draggingCustomObject) {
      const deltaX =
        position.x -
        draggingCustomObject.offsetX

      const deltaY =
        position.y -
        draggingCustomObject.offsetY

      setCustomObjects((current) => {
        return current.map((obj) => {
          if (
            obj.id !== draggingCustomObject.id
          ) {
            return obj
          }

          return {
            ...obj,
            points:
              draggingCustomObject.originalPoints.map(
                (point) => ({
                  x: snapToGrid(
                    point.x + deltaX
                  ),
                  y: snapToGrid(
                    point.y + deltaY
                  ),
                })
              ),
          }
        })
      })

      return
    }

    if (draggingVertex) {
      const newX = snapToGrid(position.x)
      const newY = snapToGrid(position.y)

      setCustomObjects((current) => {
        return current.map((obj) => {
          if (obj.id !== draggingVertex.objectId) {
            return obj
          }

          return {
            ...obj,
            points: obj.points.map(
              (point, index) =>
                index ===
                draggingVertex.vertexIndex
                  ? { x: newX, y: newY }
                  : point
            ),
          }
        })
      })

      return
    }

    if (
      isSelecting &&
      selectionStartRef.current
    ) {
      selectionMovedRef.current = true

      const start =
        selectionStartRef.current

      setSelectionBox({
        startX: start.x,
        startY: start.y,
        endX: position.x,
        endY: position.y,
      })

      const left = Math.min(
        start.x,
        position.x
      )

      const right = Math.max(
        start.x,
        position.x
      )

      const top = Math.min(
        start.y,
        position.y
      )

      const bottom = Math.max(
        start.y,
        position.y
      )

      const selected = spaces
        .filter((space) => {
          const spaceRight =
            space.x +
            SPACE_WIDTH

          const spaceBottom =
            space.y +
            SPACE_HEIGHT

          return (
            space.x < right &&
            spaceRight > left &&
            space.y < bottom &&
            spaceBottom > top
          )
        })
        .map((space) => space.id)

      setSelectedSpaces(selected)

      return
    }

    if (drawingArea && areaDrawStartRef.current) {
      const start = areaDrawStartRef.current

      setDrawingArea({
        startX: start.x,
        startY: start.y,
        endX: position.x,
        endY: position.y,
      })

      return
    }

    if (resizingArea) {
      const deltaX =
        position.x -
        resizingArea.startPointerX

      const deltaY =
        position.y -
        resizingArea.startPointerY

      const MIN_SIZE = GRID_SIZE

      let nextX = resizingArea.startX
      let nextY = resizingArea.startY
      let nextWidth = resizingArea.startWidth
      let nextHeight = resizingArea.startHeight

      if (
        resizingArea.corner === 'se' ||
        resizingArea.corner === 'ne'
      ) {
        nextWidth = Math.max(
          MIN_SIZE,
          resizingArea.startWidth + deltaX
        )
      }

      if (
        resizingArea.corner === 'sw' ||
        resizingArea.corner === 'nw'
      ) {
        const proposedWidth =
          resizingArea.startWidth - deltaX

        nextWidth = Math.max(
          MIN_SIZE,
          proposedWidth
        )

        nextX =
          resizingArea.startX +
          (resizingArea.startWidth -
            nextWidth)
      }

      if (
        resizingArea.corner === 'se' ||
        resizingArea.corner === 'sw'
      ) {
        nextHeight = Math.max(
          MIN_SIZE,
          resizingArea.startHeight + deltaY
        )
      }

      if (
        resizingArea.corner === 'ne' ||
        resizingArea.corner === 'nw'
      ) {
        const proposedHeight =
          resizingArea.startHeight - deltaY

        nextHeight = Math.max(
          MIN_SIZE,
          proposedHeight
        )

        nextY =
          resizingArea.startY +
          (resizingArea.startHeight -
            nextHeight)
      }

      setAreas((current) => {
        return current.map((area) => {
          if (area.id !== resizingArea.id) {
            return area
          }

          return {
            ...area,
            x: snapToGrid(nextX),
            y: snapToGrid(nextY),
            width: snapToGrid(nextWidth),
            height: snapToGrid(nextHeight),
          }
        })
      })

      return
    }

    if (resizingRoad) {
      const deltaX =
        position.x -
        resizingRoad.startPointerX

      const deltaY =
        position.y -
        resizingRoad.startPointerY

      const MIN_SIZE = GRID_SIZE

      let nextX = resizingRoad.startX
      let nextY = resizingRoad.startY
      let nextWidth = resizingRoad.startWidth
      let nextHeight = resizingRoad.startHeight

      if (
        resizingRoad.corner === 'se' ||
        resizingRoad.corner === 'ne'
      ) {
        nextWidth = Math.max(
          MIN_SIZE,
          resizingRoad.startWidth + deltaX
        )
      }

      if (
        resizingRoad.corner === 'sw' ||
        resizingRoad.corner === 'nw'
      ) {
        const proposedWidth =
          resizingRoad.startWidth - deltaX

        nextWidth = Math.max(
          MIN_SIZE,
          proposedWidth
        )

        nextX =
          resizingRoad.startX +
          (resizingRoad.startWidth -
            nextWidth)
      }

      if (
        resizingRoad.corner === 'se' ||
        resizingRoad.corner === 'sw'
      ) {
        nextHeight = Math.max(
          MIN_SIZE,
          resizingRoad.startHeight + deltaY
        )
      }

      if (
        resizingRoad.corner === 'ne' ||
        resizingRoad.corner === 'nw'
      ) {
        const proposedHeight =
          resizingRoad.startHeight - deltaY

        nextHeight = Math.max(
          MIN_SIZE,
          proposedHeight
        )

        nextY =
          resizingRoad.startY +
          (resizingRoad.startHeight -
            nextHeight)
      }

      setRoads((current) => {
        return current.map((road) => {
          if (road.id !== resizingRoad.id) {
            return road
          }

          return {
            ...road,
            x: snapToGrid(nextX),
            y: snapToGrid(nextY),
            width: snapToGrid(nextWidth),
            height: snapToGrid(nextHeight),
          }
        })
      })

      return
    }

    if (resizingLabel) {
      const deltaX =
        position.x -
        resizingLabel.startPointerX

      const deltaY =
        position.y -
        resizingLabel.startPointerY

      const MIN_SIZE = GRID_SIZE

      let nextX = resizingLabel.startX
      let nextY = resizingLabel.startY
      let nextWidth = resizingLabel.startWidth
      let nextHeight = resizingLabel.startHeight

      if (
        resizingLabel.corner === 'se' ||
        resizingLabel.corner === 'ne'
      ) {
        nextWidth = Math.max(
          MIN_SIZE,
          resizingLabel.startWidth + deltaX
        )
      }

      if (
        resizingLabel.corner === 'sw' ||
        resizingLabel.corner === 'nw'
      ) {
        const proposedWidth =
          resizingLabel.startWidth - deltaX

        nextWidth = Math.max(
          MIN_SIZE,
          proposedWidth
        )

        nextX =
          resizingLabel.startX +
          (resizingLabel.startWidth -
            nextWidth)
      }

      if (
        resizingLabel.corner === 'se' ||
        resizingLabel.corner === 'sw'
      ) {
        nextHeight = Math.max(
          MIN_SIZE,
          resizingLabel.startHeight + deltaY
        )
      }

      if (
        resizingLabel.corner === 'ne' ||
        resizingLabel.corner === 'nw'
      ) {
        const proposedHeight =
          resizingLabel.startHeight - deltaY

        nextHeight = Math.max(
          MIN_SIZE,
          proposedHeight
        )

        nextY =
          resizingLabel.startY +
          (resizingLabel.startHeight -
            nextHeight)
      }

      setLabels((current) => {
        return current.map((label) => {
          if (label.id !== resizingLabel.id) {
            return label
          }

          return {
            ...label,
            x: snapToGrid(nextX),
            y: snapToGrid(nextY),
            width: snapToGrid(nextWidth),
            height: snapToGrid(nextHeight),
          }
        })
      })

      return
    }

    if (draggingArea) {
      const newX = snapToGrid(
        position.x - draggingArea.offsetX
      )

      const newY = snapToGrid(
        position.y - draggingArea.offsetY
      )

      setAreas((current) => {
        return current.map((area) => {
          if (area.id !== draggingArea.id) {
            return area
          }

          return {
            ...area,
            x: newX,
            y: newY,
          }
        })
      })

      return
    }

    if (drawingRoad && roadDrawStartRef.current) {
      const start = roadDrawStartRef.current

      setDrawingRoad({
        startX: start.x,
        startY: start.y,
        endX: position.x,
        endY: position.y,
      })

      return
    }

    if (draggingRoad) {
      const newX = snapToGrid(
        position.x - draggingRoad.offsetX
      )

      const newY = snapToGrid(
        position.y - draggingRoad.offsetY
      )

      const anchorOriginal =
        draggingRoad.originalRoads.find(
          (road) =>
            road.id === draggingRoad.id
        )

      const deltaX =
        newX - snapToGrid(anchorOriginal.x)

      const deltaY =
        newY - snapToGrid(anchorOriginal.y)

      setRoads((current) => {
        return current.map((road) => {
          const original =
            draggingRoad.originalRoads.find(
              (item) => item.id === road.id
            )

          if (!original) {
            return road
          }

          return {
            ...road,
            x: snapToGrid(
              original.x + deltaX
            ),
            y: snapToGrid(
              original.y + deltaY
            ),
          }
        })
      })

      return
    }

    if (draggingLabel) {
      const newX = snapToGrid(
        position.x - draggingLabel.offsetX
      )

      const newY = snapToGrid(
        position.y - draggingLabel.offsetY
      )

      setLabels((current) => {
        return current.map((label) => {
          if (label.id === draggingLabel.id) {
            return {
              ...label,
              x: newX,
              y: newY,
            }
          }

          return label
        })
      })

      return
    }

    if (draggingSpace) {
      spaceDragMovedRef.current = true

      const newX = snapToGrid(
        position.x -
          draggingSpace.offsetX
      )

      const newY = snapToGrid(
        position.y -
          draggingSpace.offsetY
      )

      if (draggingSpace.multi) {
        const draggedOriginal =
          draggingSpace.originalSpaces.find(
            (space) =>
              space.id ===
              draggingSpace.id
          )

        if (!draggedOriginal) {
          return
        }

        const deltaX =
          newX -
          snapToGrid(
            draggedOriginal.x
          )

        const deltaY =
          newY -
          snapToGrid(
            draggedOriginal.y
          )

        setSpaces((current) => {
          return current.map((space) => {
            const original =
              draggingSpace.originalSpaces.find(
                (item) =>
                  item.id ===
                  space.id
              )

            if (!original) {
              return space
            }

            return {
              ...space,

              x: snapToGrid(
                original.x +
                  deltaX
              ),

              y: snapToGrid(
                original.y +
                  deltaY
              ),
            }
          })
        })
      } else {
        setSpaces((current) => {
          return current.map((space) => {
            if (
              space.id ===
              draggingSpace.id
            ) {
              return {
                ...space,
                x: newX,
                y: newY,
              }
            }

            return space
          })
        })
      }

      return
    }

    if (draggingVehicle) {
      const dropElement =
        typeof document !== 'undefined'
          ? document.elementFromPoint(
              event.clientX,
              event.clientY
            )
          : null

      const overUnassignedZone = Boolean(
        dropElement &&
          dropElement.closest(
            '.unassigned-drop-zone'
          )
      )

      setIsOverUnassignedZone(
        overUnassignedZone
      )

      if (overUnassignedZone) {
        setSnapTarget(null)
        return
      }

      const mouseX =
        position.x -
        draggingVehicle.offsetX

      const mouseY =
        position.y -
        draggingVehicle.offsetY

      let closestSpace = null
      let closestDistance = Infinity

      spaces.forEach((space) => {
        const centerX =
          space.x +
          SPACE_WIDTH / 2

        const centerY =
          space.y +
          SPACE_HEIGHT / 2

        const distance =
          Math.sqrt(
            Math.pow(
              mouseX -
                centerX,
              2
            ) +
              Math.pow(
                mouseY -
                  centerY,
                2
              )
          )

        if (
          distance <
            closestDistance &&
          distance <=
            SNAP_DISTANCE
        ) {
          closestDistance =
            distance

          closestSpace =
            space
        }
      })

      if (closestSpace) {
        setSnapTarget(
          closestSpace.id
        )

        setPreviewPosition({
          x:
            closestSpace.x +
            SPACE_WIDTH / 2,

          y:
            closestSpace.y +
            SPACE_HEIGHT / 2,
        })
      } else {
        setSnapTarget(null)

        setPreviewPosition({
          x: mouseX,
          y: mouseY,
        })
      }
    }
  }

  const handleMouseUp = (event) => {
    const draggedAreaId = draggingArea
      ? draggingArea.id
      : null

    const resizedAreaId = resizingArea
      ? resizingArea.id
      : null

    const draggedRoadId = draggingRoad
      ? draggingRoad.id
      : null

    const resizedRoadId = resizingRoad
      ? resizingRoad.id
      : null

    if (draggingVehicle) {
      const dropElement =
        typeof document !== 'undefined' &&
        event
          ? document.elementFromPoint(
              event.clientX,
              event.clientY
            )
          : null

      const droppedOnUnassigned =
        dropElement &&
        dropElement.closest(
          '.unassigned-drop-zone'
        )

      if (droppedOnUnassigned) {
        setVehicles((current) => {
          return current.map((vehicle) => {
            if (
              vehicle.id ===
              draggingVehicle.id
            ) {
              return {
                ...vehicle,
                spaceId: null,
              }
            }

            return vehicle
          })
        })
      } else if (snapTarget) {
        setVehicles((current) => {
          return current.map((vehicle) => {
            if (
              vehicle.id ===
              draggingVehicle.id
            ) {
              return {
                ...vehicle,
                spaceId: snapTarget,
              }
            }

            return vehicle
          })
        })
      }
    }

    if (draggingSpace && spaceDragMovedRef.current) {
      justFinishedDraggingSpace.current = true
    }

    spaceDragMovedRef.current = false

    setDraggingSpace(null)
    setDraggingVehicle(null)
    setDraggingArea(null)
    setResizingArea(null)
    setDraggingRoad(null)
    setResizingRoad(null)
    setDraggingLabel(null)
    setResizingLabel(null)
    setDraggingCustomObject(null)
    setDraggingVertex(null)
    setPreviewPosition(null)
    setSnapTarget(null)
    setIsOverUnassignedZone(false)

    if (draggedRoadId) {
      setRoads((current) =>
        computeGroupsPerLot(current)
      )
    }

    if (resizedRoadId) {
      setRoads((current) =>
        computeGroupsPerLot(current)
      )
    }

    if (drawingArea) {
      const width = Math.abs(
        drawingArea.endX - drawingArea.startX
      )

      const height = Math.abs(
        drawingArea.endY - drawingArea.startY
      )

      if (width > 20 && height > 20) {
        const newArea = {
          id: Date.now(),

          x: snapToGrid(
            Math.min(
              drawingArea.startX,
              drawingArea.endX
            )
          ),

          y: snapToGrid(
            Math.min(
              drawingArea.startY,
              drawingArea.endY
            )
          ),

          width: snapToGrid(width),
          height: snapToGrid(height),

          label:
            'Object ' + (areas.length + 1),

          color: OBJECT_COLORS[0],
          lotId: activeLotId,
        }

        setAreas((current) => [
          ...current,
          newArea,
        ])

        setSelectedArea(newArea.id)
      }

      setDrawingArea(null)
      areaDrawStartRef.current = null
      setActiveTool('select')
    }

    if (drawingRoad) {
      const width = Math.abs(
        drawingRoad.endX - drawingRoad.startX
      )

      const height = Math.abs(
        drawingRoad.endY - drawingRoad.startY
      )

      if (width > 20 && height > 20) {
        const newRoad = {
          id: Date.now(),

          x: snapToGrid(
            Math.min(
              drawingRoad.startX,
              drawingRoad.endX
            )
          ),

          y: snapToGrid(
            Math.min(
              drawingRoad.startY,
              drawingRoad.endY
            )
          ),

          width: snapToGrid(width),
          height: snapToGrid(height),
          lotId: activeLotId,
        }

        setRoads((current) =>
          computeGroupsPerLot([
            ...current,
            newRoad,
          ])
        )

        setSelectedRoad(newRoad.id)
      }

      setDrawingRoad(null)
      roadDrawStartRef.current = null
    }

    if (isSelecting) {
      setIsSelecting(false)
      setSelectionBox(null)

      selectionStartRef.current =
        null

      if (selectionMovedRef.current) {
        justFinishedSelecting.current =
          true
      }

      selectionMovedRef.current = false
    }
  }

  const updateSpaceName = (event) => {
    const newName = event.target.value

    setSpaces((current) => {
      return current.map((space) => {
        if (space.id === selectedSpace) {
          return {
            ...space,
            label: newName,
          }
        }

        return space
      })
    })
  }

  const rotateSpace = (spaceId) => {
    pushHistory()

    setSpaces((current) => {
      return current.map((space) => {
        if (space.id === spaceId) {
          return {
            ...space,
            rotation:
              ((space.rotation || 0) + 45) %
              360,
          }
        }

        return space
      })
    })
  }

  const rotateSelectedSpaces = () => {
    const idsRequested =
      selectedSpaces.length > 1
        ? selectedSpaces
        : selectedSpace
        ? [selectedSpace]
        : []

    if (idsRequested.length === 0) {
      return
    }

    pushHistory()

    setSpaces((current) => {
      return current.map((space) => {
        if (idsRequested.includes(space.id)) {
          return {
            ...space,
            rotation:
              ((space.rotation || 0) + 45) %
              360,
          }
        }

        return space
      })
    })
  }

  const deleteSelectedSpaces = () => {
    const idsRequested =
      selectedSpaces.length > 1
        ? selectedSpaces
        : selectedSpace
        ? [selectedSpace]
        : []

    if (idsRequested.length === 0) {
      return
    }

    const occupiedSpaceIds = new Set(
      vehicles
        .filter(
          (vehicle) =>
            vehicle.spaceId !== null
        )
        .map((vehicle) => vehicle.spaceId)
    )

    const idsToDelete = idsRequested.filter(
      (id) => !occupiedSpaceIds.has(id)
    )

    if (idsToDelete.length === 0) {
      return
    }

    pushHistory()

    setSpaces((current) => {
      return current.filter(
        (space) =>
          !idsToDelete.includes(space.id)
      )
    })

    setSelectedSpace(null)
    setSelectedSpaces([])
    setIsRenamingSpace(false)
  }

  const startAreaDrag = (event, area) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    setDraggingArea({
      id: area.id,
      offsetX: position.x - area.x,
      offsetY: position.y - area.y,
    })

    setSelectedArea(area.id)
    setSelectedSpace(null)
    setSelectedVehicle(null)
    setSelectedSpaces([])
    setShowAddCar(false)
  }

  const startAreaResize = (event, area, corner) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    setResizingArea({
      id: area.id,
      corner,
      startPointerX: position.x,
      startPointerY: position.y,
      startX: area.x,
      startY: area.y,
      startWidth: area.width,
      startHeight: area.height,
    })
  }

  const startRoadResize = (event, road, corner) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    setResizingRoad({
      id: road.id,
      corner,
      startPointerX: position.x,
      startPointerY: position.y,
      startX: road.x,
      startY: road.y,
      startWidth: road.width,
      startHeight: road.height,
    })
  }

  const startLabelResize = (
    event,
    label,
    corner
  ) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    setResizingLabel({
      id: label.id,
      corner,
      startPointerX: position.x,
      startPointerY: position.y,
      startX: label.x,
      startY: label.y,
      startWidth: label.width || 84,
      startHeight: label.height || 32,
    })
  }

  const startRoadDrag = (event, road) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    const groupMembers = road.groupId
      ? roads.filter(
          (item) =>
            item.groupId === road.groupId
        )
      : [road]

    setDraggingRoad({
      id: road.id,
      offsetX: position.x - road.x,
      offsetY: position.y - road.y,
      originalRoads: groupMembers.map(
        (item) => ({
          id: item.id,
          x: item.x,
          y: item.y,
        })
      ),
    })

    setSelectedRoad(road.id)
    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedVehicle(null)
    setSelectedSpaces([])
    setShowAddCar(false)
  }

  const deleteRoad = () => {
    pushHistory()

    setRoads((current) => {
      const target = current.find(
        (road) => road.id === selectedRoad
      )

      if (!target) {
        return current
      }

      if (target.groupId) {
        return current.filter(
          (road) =>
            road.groupId !== target.groupId
        )
      }

      return current.filter(
        (road) => road.id !== target.id
      )
    })

    setSelectedRoad(null)
  }

  const startLabelDrag = (event, label) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    setDraggingLabel({
      id: label.id,
      offsetX: position.x - label.x,
      offsetY: position.y - label.y,
    })

    setSelectedLabel(label.id)
    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedRoad(null)
    setSelectedVehicle(null)
    setSelectedSpaces([])
    setShowAddCar(false)
  }

  const updateLabelText = (event) => {
    const newText = event.target.value

    setLabels((current) => {
      return current.map((label) => {
        if (label.id === selectedLabel) {
          return {
            ...label,
            text: newText,
          }
        }

        return label
      })
    })
  }

  const deleteLabel = () => {
    pushHistory()

    setLabels((current) =>
      current.filter(
        (label) => label.id !== selectedLabel
      )
    )

    setSelectedLabel(null)
  }

  const rotateLabel = (labelId) => {
    pushHistory()

    setLabels((current) => {
      return current.map((label) => {
        if (label.id === labelId) {
          return {
            ...label,
            rotation:
              ((label.rotation || 0) + 45) %
              360,
          }
        }

        return label
      })
    })
  }

  const startCustomObjectDrag = (
    event,
    obj
  ) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    const position = getMousePosition(event)

    setDraggingCustomObject({
      id: obj.id,
      offsetX: position.x,
      offsetY: position.y,
      originalPoints: obj.points,
    })

    setSelectedCustomObject(obj.id)
    setSelectedSpace(null)
    setSelectedArea(null)
    setSelectedRoad(null)
    setSelectedLabel(null)
    setSelectedVehicle(null)
    setSelectedSpaces([])
    setShowAddCar(false)
  }

  const startVertexDrag = (
    event,
    obj,
    vertexIndex
  ) => {
    if (!showToolsPanel) {
      return
    }

    event.stopPropagation()

    pushHistory()

    setDraggingVertex({
      objectId: obj.id,
      vertexIndex,
    })
  }

  const updateCustomObjectLabel = (event) => {
    const newName = event.target.value

    setCustomObjects((current) => {
      return current.map((obj) => {
        if (obj.id === selectedCustomObject) {
          return {
            ...obj,
            label: newName,
          }
        }

        return obj
      })
    })
  }

  const updateCustomObjectColor = (color) => {
    pushHistory()

    setCustomObjects((current) => {
      return current.map((obj) => {
        if (obj.id === selectedCustomObject) {
          return {
            ...obj,
            color,
          }
        }

        return obj
      })
    })
  }

  const deleteCustomObject = () => {
    pushHistory()

    setCustomObjects((current) =>
      current.filter(
        (obj) =>
          obj.id !== selectedCustomObject
      )
    )

    setSelectedCustomObject(null)
  }

  const copySelection = () => {
    if (selectedSpaces.length > 0) {
      const items = spaces.filter((space) =>
        selectedSpaces.includes(space.id)
      )

      if (items.length > 0) {
        setClipboard({
          type: 'spaces',
          items,
        })
      }

      return
    }

    if (selectedSpace) {
      const item = spaces.find(
        (space) => space.id === selectedSpace
      )

      if (item) {
        setClipboard({
          type: 'spaces',
          items: [item],
        })
      }

      return
    }

    if (selectedArea) {
      const item = areas.find(
        (area) => area.id === selectedArea
      )

      if (item) {
        setClipboard({
          type: 'area',
          item,
        })
      }

      return
    }

    if (selectedRoad) {
      const item = roads.find(
        (road) => road.id === selectedRoad
      )

      if (item) {
        setClipboard({
          type: 'road',
          item,
        })
      }

      return
    }

    if (selectedLabel) {
      const item = labels.find(
        (label) => label.id === selectedLabel
      )

      if (item) {
        setClipboard({
          type: 'label',
          item,
        })
      }

      return
    }

    if (selectedCustomObject) {
      const item = customObjects.find(
        (obj) =>
          obj.id === selectedCustomObject
      )

      if (item) {
        setClipboard({
          type: 'customObject',
          item,
        })
      }

      return
    }
  }

  const pasteClipboard = () => {
    if (!clipboard) {
      return
    }

    pushHistory()

    const PASTE_OFFSET = GRID_SIZE * 2

    if (clipboard.type === 'spaces') {
      const newIds = []

      const newItems = clipboard.items.map(
        (item, index) => {
          const id = Date.now() + index
          newIds.push(id)

          return {
            ...item,
            id,
            x: snapToGrid(
              item.x + PASTE_OFFSET
            ),
            y: snapToGrid(
              item.y + PASTE_OFFSET
            ),
            lotId: activeLotId,
          }
        }
      )

      setSpaces((current) => [
        ...current,
        ...newItems,
      ])

      setSelectedSpace(null)
      setSelectedSpaces(newIds)
      return
    }

    if (clipboard.type === 'area') {
      const newItem = {
        ...clipboard.item,
        id: Date.now(),
        x: snapToGrid(
          clipboard.item.x + PASTE_OFFSET
        ),
        y: snapToGrid(
          clipboard.item.y + PASTE_OFFSET
        ),
        lotId: activeLotId,
      }

      setAreas((current) => [
        ...current,
        newItem,
      ])

      setSelectedArea(newItem.id)
      return
    }

    if (clipboard.type === 'road') {
      const newItem = {
        ...clipboard.item,
        id: Date.now(),
        x: snapToGrid(
          clipboard.item.x + PASTE_OFFSET
        ),
        y: snapToGrid(
          clipboard.item.y + PASTE_OFFSET
        ),
        groupId: null,
        lotId: activeLotId,
      }

      setRoads((current) =>
        computeGroupsPerLot([
          ...current,
          newItem,
        ])
      )

      setSelectedRoad(newItem.id)
      return
    }

    if (clipboard.type === 'label') {
      const newItem = {
        ...clipboard.item,
        id: Date.now(),
        x: snapToGrid(
          clipboard.item.x + PASTE_OFFSET
        ),
        y: snapToGrid(
          clipboard.item.y + PASTE_OFFSET
        ),
        lotId: activeLotId,
      }

      setLabels((current) => [
        ...current,
        newItem,
      ])

      setSelectedLabel(newItem.id)
      return
    }

    if (clipboard.type === 'customObject') {
      const newItem = {
        ...clipboard.item,
        id: Date.now(),
        points: clipboard.item.points.map(
          (point) => ({
            x: snapToGrid(
              point.x + PASTE_OFFSET
            ),
            y: snapToGrid(
              point.y + PASTE_OFFSET
            ),
          })
        ),
        lotId: activeLotId,
      }

      setCustomObjects((current) => [
        ...current,
        newItem,
      ])

      setSelectedCustomObject(newItem.id)
      return
    }
  }

  const updateAreaName = (event) => {
    const newName = event.target.value

    setAreas((current) => {
      return current.map((area) => {
        if (area.id === selectedArea) {
          return {
            ...area,
            label: newName,
          }
        }

        return area
      })
    })
  }

  const updateAreaColor = (color) => {
    pushHistory()

    setAreas((current) => {
      return current.map((area) => {
        if (area.id === selectedArea) {
          return {
            ...area,
            color,
          }
        }

        return area
      })
    })
  }

  const deleteArea = () => {
    pushHistory()

    setAreas((current) =>
      current.filter(
        (area) => area.id !== selectedArea
      )
    )

    setSelectedArea(null)
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      const activeTag =
        document.activeElement &&
        document.activeElement.tagName

      const isTyping =
        activeTag === 'INPUT' ||
        activeTag === 'TEXTAREA' ||
        activeTag === 'SELECT'

      const key = event.key.toLowerCase()

      const isUndoCombo =
        (event.metaKey ||
          event.ctrlKey) &&
        !event.shiftKey &&
        key === 'z'

      const isRedoCombo =
        (event.metaKey ||
          event.ctrlKey) &&
        ((event.shiftKey &&
          key === 'z') ||
          key === 'y')

      if (isUndoCombo && !isTyping) {
        event.preventDefault()
        undo()
        return
      }

      if (isRedoCombo && !isTyping) {
        event.preventDefault()
        redo()
        return
      }

      const isCopyCombo =
        (event.metaKey ||
          event.ctrlKey) &&
        key === 'c'

      const isPasteCombo =
        (event.metaKey ||
          event.ctrlKey) &&
        key === 'v'

      if (
        isCopyCombo &&
        !isTyping &&
        showToolsPanel
      ) {
        event.preventDefault()
        copySelection()
        return
      }

      if (
        isPasteCombo &&
        !isTyping &&
        showToolsPanel
      ) {
        event.preventDefault()
        pasteClipboard()
        return
      }

      if (
        event.key === 'Escape' &&
        drawingCustomObject
      ) {
        event.preventDefault()
        setDrawingCustomObject(null)
        setCustomObjectPreviewPos(null)
        return
      }

      if (
        event.key !== 'Backspace' &&
        event.key !== 'Delete'
      ) {
        return
      }

      if (isTyping) {
        return
      }

      if (selectedVehicle) {
        event.preventDefault()
        deleteVehicle()
        return
      }

      if (showToolsPanel && selectedArea) {
        event.preventDefault()
        deleteArea()
        return
      }

      if (showToolsPanel && selectedRoad) {
        event.preventDefault()
        deleteRoad()
        return
      }

      if (showToolsPanel && selectedLabel) {
        event.preventDefault()
        deleteLabel()
        return
      }

      if (
        showToolsPanel &&
        selectedCustomObject
      ) {
        event.preventDefault()
        deleteCustomObject()
        return
      }

      if (
        showToolsPanel &&
        (selectedSpace ||
          selectedSpaces.length > 0)
      ) {
        event.preventDefault()
        deleteSelectedSpaces()
      }
    }

    window.addEventListener(
      'keydown',
      handleKeyDown
    )

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown
      )
    }
  }, [
    selectedVehicle,
    selectedArea,
    selectedRoad,
    selectedLabel,
    selectedCustomObject,
    drawingCustomObject,
    selectedSpace,
    selectedSpaces,
    showToolsPanel,
    past,
    future,
    spaces,
    areas,
    roads,
    labels,
    customObjects,
    vehicles,
    lots,
    activeLotId,
    clipboard,
  ])

  const selectedSpaceData =
    spaces.find(
      (space) =>
        space.id === selectedSpace
    )

  const selectedSpaceVehicle =
    selectedSpaceData &&
    vehicles.find(
      (vehicle) =>
        vehicle.spaceId ===
        selectedSpaceData.id
    )

  const selectedAreaData =
    areas.find(
      (area) =>
        area.id === selectedArea
    )

  const selectedRoadData =
    roads.find(
      (road) =>
        road.id === selectedRoad
    )

  const selectedLabelData =
    labels.find(
      (label) =>
        label.id === selectedLabel
    )

  const selectedCustomObjectData =
    customObjects.find(
      (obj) =>
        obj.id === selectedCustomObject
    )

  const visibleSpaces = spaces.filter(
    (space) =>
      (space.lotId || 1) === activeLotId
  )

  const visibleAreas = areas.filter(
    (area) =>
      (area.lotId || 1) === activeLotId
  )

  const visibleRoads = roads.filter(
    (road) =>
      (road.lotId || 1) === activeLotId
  )

  const visibleLabels = labels.filter(
    (label) =>
      (label.lotId || 1) === activeLotId
  )

  const visibleCustomObjects =
    customObjects.filter(
      (obj) =>
        (obj.lotId || 1) === activeLotId
    )

  const selectedVehicleData =
    vehicles.find(
      (vehicle) =>
        vehicle.id === selectedVehicle
    )

  const STATUS_SORT_ORDER = [
    'sold',
    'reserved',
    'demo',
    'test-drive',
    'waiting-pdi',
    'waiting-cleaning',
    'cleaned',
    'ready',
  ]

  const sortByStatus = (list) => {
    return [...list].sort((a, b) => {
      return (
        STATUS_SORT_ORDER.indexOf(a.status) -
        STATUS_SORT_ORDER.indexOf(b.status)
      )
    })
  }

  const unassignedVehicles = sortByStatus(
    vehicles.filter(
      (vehicle) =>
        vehicle.spaceId === null
    )
  )

  const assignedVehicles = sortByStatus(
    vehicles.filter(
      (vehicle) =>
        vehicle.spaceId !== null
    )
  )

  const trimmedSearch = searchQuery
    .trim()
    .toLowerCase()

  const searchMatches =
    trimmedSearch.length >= 2
      ? vehicles
          .filter((vehicle) => {
            const reg = (
              vehicle.registration || ''
            ).toLowerCase()

            const vin = (
              vehicle.vin || ''
            ).toLowerCase()

            return (
              reg.includes(
                trimmedSearch
              ) ||
              vin.includes(trimmedSearch)
            )
          })
          .slice(0, 8)
      : []

  const recentSearchVehicles = recentSearches
    .map((id) =>
      vehicles.find(
        (vehicle) => vehicle.id === id
      )
    )
    .filter(Boolean)

  const showRecentSearches =
    isSearchFocused &&
    trimmedSearch.length < 2 &&
    recentSearchVehicles.length > 0

  if (
    authLoading ||
    (session && orgLoading)
  ) {
    return (
      <div className="auth-loading-screen">
        <div className="auth-loading-spinner" />
      </div>
    )
  }

  if (!session) {
    return <LoginScreen />
  }

  if (!membership) {
    return (
      <OrgGateScreen
        userId={session.user.id}
        onDone={() =>
          loadMembership(session.user.id)
        }
      />
    )
  }

  return (
    <div
      className="app"
      onMouseMove={
        handleMouseMove
      }
      onMouseUp={
        handleMouseUp
      }
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            Car Finder
          </div>

          <div className="brand-subtitle"></div>
        </div>

        <div className="sidebar-search">
          <span className="sidebar-search-icon">
            ⌕
          </span>

          <input
            type="text"
            value={searchQuery}
            onChange={(event) =>
              setSearchQuery(
                event.target.value
              )
            }
            onFocus={() =>
              setIsSearchFocused(true)
            }
            onBlur={() =>
              setTimeout(() => {
                setIsSearchFocused(false)
              }, 150)
            }
            placeholder="Search plate or VIN…"
            className="sidebar-search-input"
          />

          {searchMatches.length > 0 && (
            <div className="sidebar-search-results">
              {searchMatches.map(
                (vehicle) => (
                  <button
                    key={vehicle.id}
                    className="sidebar-search-result"
                    onClick={() =>
                      jumpToVehicle(vehicle)
                    }
                  >
                    <div className="sidebar-search-result-top">
                      <strong>
                        {vehicle.vin
                          ? formatVinShort(
                              vehicle.vin
                            )
                          : 'NO VIN'}
                      </strong>

                      <span>
                        {vehicle.spaceId
                          ? 'On map'
                          : 'Unassigned'}
                      </span>
                    </div>

                    <span className="sidebar-search-result-reg">
                      {vehicle.registration
                        ? `Reg: ${vehicle.registration}`
                        : 'NO REGISTRATION'}
                    </span>
                  </button>
                )
              )}
            </div>
          )}

          {showRecentSearches && (
            <div className="sidebar-search-results">
              <div className="sidebar-search-results-label">
                RECENT SEARCHES
              </div>

              {recentSearchVehicles.map(
                (vehicle) => (
                  <button
                    key={vehicle.id}
                    className="sidebar-search-result"
                    onClick={() =>
                      jumpToVehicle(vehicle)
                    }
                  >
                    <div className="sidebar-search-result-top">
                      <strong>
                        {vehicle.vin
                          ? formatVinShort(
                              vehicle.vin
                            )
                          : 'NO VIN'}
                      </strong>

                      <span>
                        {vehicle.spaceId
                          ? 'On map'
                          : 'Unassigned'}
                      </span>
                    </div>

                    <span className="sidebar-search-result-reg">
                      {vehicle.registration
                        ? `Reg: ${vehicle.registration}`
                        : 'NO REGISTRATION'}
                    </span>
                  </button>
                )
              )}
            </div>
          )}
        </div>

        <div className="sidebar-section">
          <div className="section-label">
            VEHICLES
          </div>

          <div className="vehicle-list">
            {assignedVehicles.map(
              (vehicle) => (
                <button
                  key={vehicle.id}
                  className={
                    'vehicle-list-item status-' +
                    vehicle.status
                  }
                  onClick={() => {
                    jumpToVehicle(vehicle)
                  }}
                >
                  <div className="vehicle-list-top">
                    <strong>
                      {vehicle.vin
                        ? formatVinShort(vehicle.vin)
                        : 'NO VIN'}
                    </strong>

                    <span className={'vehicle-status-dot status-dot-' + vehicle.status} />
                  </div>

                  <span>
                    {vehicle.registration
                      ? `Reg: ${vehicle.registration}`
                      : 'NO REGISTRATION'}
                  </span>

                  {vehicle.make && (
                    <span>
                      {vehicle.make}
                    </span>
                  )}
                </button>
              )
            )}
          </div>
        </div>

        <div
          className={
            'sidebar-section unassigned-drop-zone' +
            (isOverUnassignedZone
              ? ' drop-active'
              : '')
          }
        >
          <div className="section-label">
            UNASSIGNED VEHICLES
          </div>

          <div className="vehicle-list">
            {unassignedVehicles.length === 0 ? (
              <div className="vehicle-list-empty">
                No unassigned vehicles
              </div>
            ) : (
              unassignedVehicles.map(
                (vehicle) => (
                  <button
                    key={vehicle.id}
                    className={
                      'vehicle-list-item status-' +
                      vehicle.status
                    }
                    onMouseDown={(event) => {
                      startUnassignedVehicleDrag(
                        event,
                        vehicle
                      )
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      jumpToVehicle(vehicle)
                    }}
                  >
                    <div className="vehicle-list-top">
                      <strong>
                        {vehicle.vin
                          ? formatVinShort(vehicle.vin)
                          : 'NO VIN'}
                      </strong>

                      <span className={'vehicle-status-dot status-dot-' + vehicle.status} />
                    </div>

                    <span>
                      {vehicle.registration
                        ? `Reg: ${vehicle.registration}`
                        : 'NO REGISTRATION'}
                    </span>

                    {vehicle.make && (
                      <span>
                        {vehicle.make}
                      </span>
                    )}
                  </button>
                )
              )
            )}
          </div>

          <button
            ref={addCarButtonRef}
            className="inline-add-button"
            onClick={() => {
              const rect =
                addCarButtonRef.current.getBoundingClientRect()

              const opensUpward =
                rect.top >
                window.innerHeight / 2

              setAddCarAnchor(
                opensUpward
                  ? {
                      bottom:
                        window.innerHeight -
                        rect.bottom,
                      left: rect.right + 12,
                    }
                  : {
                      top: rect.top,
                      left: rect.right + 12,
                    }
              )

              setShowAddCar(true)
              setSelectedVehicle(null)
              setSelectedSpace(null)
              setSelectedSpaces([])
            }}
          >
            <span className="inline-add-icon">
              +
            </span>

            Add car
          </button>
        </div>

        <div className="sidebar-bottom">
          {showToolsPanel && (
            <div className="tools-panel">
              <div className="section-label">
                TOOLS
              </div>

              <button
                className={
                  'tool' +
                  (activeTool === 'select'
                    ? ' active'
                    : '')
                }
                onClick={() =>
                  setActiveTool('select')
                }
              >
                <span className="tool-icon">
                  ⌁
                </span>

                Select
              </button>

              <div className="tool-with-count">
                <button
                  className="tool tool-with-count-button"
                  onClick={() =>
                    addSpace(spaceAddCount)
                  }
                >
                  <span className="tool-icon">
                    ⊞
                  </span>

                  {spaceAddCount > 1
                    ? `Add ${spaceAddCount} spaces`
                    : 'Parking space'}
                </button>

                <input
                  type="number"
                  min={1}
                  max={50}
                  value={spaceAddCount}
                  onChange={(event) => {
                    const value = Math.max(
                      1,
                      Math.min(
                        50,
                        Number(
                          event.target.value
                        ) || 1
                      )
                    )

                    setSpaceAddCount(value)
                  }}
                  className="tool-count-input"
                />
              </div>

              <button
                className={
                  'tool' +
                  (activeTool === 'area'
                    ? ' active'
                    : '')
                }
                onClick={() =>
                  setActiveTool('area')
                }
              >
                <span className="tool-icon">
                  □
                </span>

                Object
              </button>

              <button
                className={
                  'tool' +
                  (activeTool ===
                  'customObject'
                    ? ' active'
                    : '')
                }
                onClick={() => {
                  setActiveTool('customObject')
                  setDrawingCustomObject(null)
                  setCustomObjectPreviewPos(
                    null
                  )
                }}
              >
                <span className="tool-icon">
                  ⬠
                </span>

                Custom object
              </button>

              <button
                className={
                  'tool' +
                  (activeTool === 'road'
                    ? ' active'
                    : '')
                }
                onClick={() =>
                  setActiveTool('road')
                }
              >
                <span className="tool-icon">
                  ╱
                </span>

                Road
              </button>

              <button
                className={
                  'tool' +
                  (activeTool === 'label'
                    ? ' active'
                    : '')
                }
                onClick={() =>
                  setActiveTool('label')
                }
              >
                <span className="tool-icon">
                  T
                </span>

                Label
              </button>
            </div>
          )}

          <div className="sidebar-footer">
            <button
              className={
                'footer-button edit-toggle' +
                (showToolsPanel
                  ? ' active'
                  : '')
              }
              onClick={toggleEditMode}
            >
              ✎ Edit
            </button>

            <div className="settings-button-wrap">
              <button
                className={
                  'footer-button settings-button' +
                  (showSettingsDropdown
                    ? ' active'
                    : '')
                }
                onClick={() =>
                  setShowSettingsDropdown(
                    (current) => !current
                  )
                }
                title="Settings"
              >
                ⚙
              </button>

              {showSettingsDropdown && (
                <>
                  <div
                    className="settings-dropdown-backdrop"
                    onClick={() =>
                      setShowSettingsDropdown(
                        false
                      )
                    }
                  />

                  <div className="settings-dropdown">
                    <div className="settings-dropdown-arrow" />

                    <button
                      className="settings-dropdown-item"
                      onClick={() => {
                        setShowSettingsDropdown(
                          false
                        )
                        setShowSettingsPanel(
                          true
                        )
                      }}
                    >
                      Organization
                    </button>

                    <div className="settings-dropdown-divider" />

                    <button
                      className="settings-dropdown-item settings-dropdown-danger"
                      onClick={() => {
                        setShowSettingsDropdown(
                          false
                        )
                        supabase.auth.signOut()
                      }}
                    >
                      <span className="settings-dropdown-icon">
                        ⏻
                      </span>
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="workspace">
          <div
            className={
              'canvas' +
              (activeTool === 'area' ||
              activeTool === 'road' ||
              activeTool === 'label' ||
              activeTool === 'customObject'
                ? ' area-tool-active'
                : '')
            }
            ref={canvasRef}
            onMouseDown={
              handleCanvasMouseDown
            }
            onClick={
              handleCanvasClick
            }
          >
            <div
              className="canvas-world"
              style={{
                transform:
                  `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin:
                  '0 0',
              }}
            >
              <div className="canvas-grid" />

              {visibleRoads.map((road) => {
                const groupRoads = road.groupId
                  ? roads.filter(
                      (item) =>
                        item.groupId ===
                        road.groupId
                    )
                  : [road]

                const isGrouped =
                  groupRoads.length > 1

                const selectedRoadGroupId =
                  selectedRoadData &&
                  selectedRoadData.groupId

                const isSelected =
                  selectedRoad &&
                  (road.id === selectedRoad ||
                    (road.groupId &&
                      selectedRoadGroupId &&
                      road.groupId ===
                        selectedRoadGroupId))

                return (
                  <div
                    key={road.id}
                    className={
                      'map-road' +
                      (isSelected
                        ? ' selected'
                        : '')
                    }
                    style={{
                      left: road.x,
                      top: road.y,
                      width: road.width,
                      height: road.height,
                      borderRadius: isGrouped
                        ? 0
                        : undefined,
                      cursor: showToolsPanel
                        ? 'grab'
                        : 'default',
                    }}
                    onMouseDown={(event) =>
                      startRoadDrag(
                        event,
                        road
                      )
                    }
                    onClick={(event) => {
                      if (!showToolsPanel) {
                        return
                      }

                      event.stopPropagation()

                      if (
                        justFinishedSelecting.current
                      ) {
                        justFinishedSelecting.current =
                          false

                        return
                      }

                      setSelectedRoad(road.id)
                      setSelectedSpace(null)
                      setSelectedArea(null)
                      setSelectedVehicle(null)
                      setSelectedSpaces([])
                      setShowAddCar(false)
                    }}
                  />
                )
              })}

              {getSeamSegments(visibleRoads).map(
                (segment) => (
                  <div
                    key={segment.id}
                    className="map-road-seam"
                    style={{
                      left: segment.x,
                      top: segment.y,
                      width: segment.width,
                      height: segment.height,
                    }}
                  />
                )
              )}

              {showToolsPanel &&
                selectedRoadData &&
                [
                  { corner: 'nw', cx: 0, cy: 0 },
                  { corner: 'ne', cx: 1, cy: 0 },
                  { corner: 'sw', cx: 0, cy: 1 },
                  { corner: 'se', cx: 1, cy: 1 },
                ].map((handle) => (
                  <div
                    key={handle.corner}
                    className={
                      'resize-handle resize-handle-' +
                      handle.corner
                    }
                    style={{
                      left:
                        selectedRoadData.x +
                        selectedRoadData.width *
                          handle.cx,
                      top:
                        selectedRoadData.y +
                        selectedRoadData.height *
                          handle.cy,
                    }}
                    onMouseDown={(event) =>
                      startRoadResize(
                        event,
                        selectedRoadData,
                        handle.corner
                      )
                    }
                  />
                ))}

              {drawingRoad && (
                <div
                  className="map-road drawing-road"
                  style={{
                    left: Math.min(
                      drawingRoad.startX,
                      drawingRoad.endX
                    ),
                    top: Math.min(
                      drawingRoad.startY,
                      drawingRoad.endY
                    ),
                    width: Math.abs(
                      drawingRoad.endX -
                        drawingRoad.startX
                    ),
                    height: Math.abs(
                      drawingRoad.endY -
                        drawingRoad.startY
                    ),
                  }}
                />
              )}

              {visibleAreas.map((area) => {
                const isSelected =
                  area.id === selectedArea

                const objectColor =
                  area.color ||
                  OBJECT_COLORS[0]

                return (
                  <div
                    key={area.id}
                    className={
                      'map-area' +
                      (isSelected
                        ? ' selected'
                        : '')
                    }
                    style={{
                      left: area.x,
                      top: area.y,
                      width: area.width,
                      height: area.height,
                      borderRadius: 6,
                      border: isSelected
                        ? '2px solid #3d6f9d'
                        : '2px solid #20252a',
                      background: isSelected
                        ? 'rgba(61, 111, 157, 0.18)'
                        : hexToRgba(
                            objectColor,
                            0.16
                          ),
                      cursor: showToolsPanel
                        ? 'grab'
                        : 'default',
                    }}
                    onMouseDown={(event) =>
                      startAreaDrag(
                        event,
                        area
                      )
                    }
                    onClick={(event) => {
                      if (!showToolsPanel) {
                        return
                      }

                      event.stopPropagation()

                      if (
                        justFinishedSelecting.current
                      ) {
                        justFinishedSelecting.current =
                          false

                        return
                      }

                      setSelectedArea(area.id)
                      setSelectedSpace(null)
                      setSelectedVehicle(null)
                      setSelectedSpaces([])
                      setShowAddCar(false)
                    }}
                  >
                    <span className="map-area-label">
                      {area.label}
                    </span>
                  </div>
                )
              })}

              {showToolsPanel &&
                selectedAreaData &&
                [
                  { corner: 'nw', cx: 0, cy: 0 },
                  { corner: 'ne', cx: 1, cy: 0 },
                  { corner: 'sw', cx: 0, cy: 1 },
                  { corner: 'se', cx: 1, cy: 1 },
                ].map((handle) => (
                  <div
                    key={handle.corner}
                    className={
                      'resize-handle resize-handle-' +
                      handle.corner
                    }
                    style={{
                      left:
                        selectedAreaData.x +
                        selectedAreaData.width *
                          handle.cx,
                      top:
                        selectedAreaData.y +
                        selectedAreaData.height *
                          handle.cy,
                    }}
                    onMouseDown={(event) =>
                      startAreaResize(
                        event,
                        selectedAreaData,
                        handle.corner
                      )
                    }
                  />
                ))}

              {drawingArea && (
                <div
                  className="map-area drawing-area"
                  style={{
                    left: Math.min(
                      drawingArea.startX,
                      drawingArea.endX
                    ),
                    top: Math.min(
                      drawingArea.startY,
                      drawingArea.endY
                    ),
                    width: Math.abs(
                      drawingArea.endX -
                        drawingArea.startX
                    ),
                    height: Math.abs(
                      drawingArea.endY -
                        drawingArea.startY
                    ),
                  }}
                />
              )}

              {visibleSpaces.map(
                (space) => {
                  const vehicle =
                    vehicles.find(
                      (item) =>
                        item.spaceId ===
                        space.id
                    )

                  const isMultiSelected =
                    selectedSpaces.includes(
                      space.id
                    )

                  return (
                    <div
                      key={space.id}
                      className={
                        'parking-space' +
                        (selectedSpace ===
                        space.id
                          ? ' selected'
                          : '') +
                        (isMultiSelected
                          ? ' multi-selected'
                          : '') +
                        (snapTarget ===
                        space.id
                          ? ' snap-target'
                          : '') +
                        (highlightSpaceId ===
                        space.id
                          ? ' search-highlight'
                          : '') +
                        (vehicle
                          ? ` status-${vehicle.status}`
                          : '')
                      }
                      style={{
                        left: space.x,
                        top: space.y,
                        transform: `rotate(${
                          space.rotation || 0
                        }deg)`,
                        cursor: showToolsPanel
                          ? 'grab'
                          : 'default',
                      }}
                      onMouseDown={(event) => {
                        startSpaceDrag(
                          event,
                          space
                        )
                      }}
                      onClick={(event) => {
                        event.stopPropagation()

                        if (
                          justFinishedSelecting.current
                        ) {
                          justFinishedSelecting.current =
                            false

                          return
                        }

                        if (
                          justFinishedDraggingSpace.current
                        ) {
                          justFinishedDraggingSpace.current =
                            false

                          return
                        }

                        if (
                          selectedSpaces.length >
                            1 &&
                          selectedSpaces.includes(
                            space.id
                          )
                        ) {
                          return
                        }

                        setSelectedSpace(
                          null
                        )

                        setIsRenamingSpace(
                          false
                        )

                        setSelectedVehicle(
                          null
                        )

                        setShowAddCar(
                          false
                        )

                        if (
                          !event.shiftKey
                        ) {
                          setSelectedSpaces(
                            []
                          )
                        }
                      }}
                      onDoubleClick={(event) => {
                        if (!showToolsPanel) {
                          return
                        }

                        event.stopPropagation()

                        pushHistory()

                        setSelectedSpace(
                          space.id
                        )

                        setIsRenamingSpace(
                          true
                        )

                        setSelectedVehicle(
                          null
                        )

                        setShowAddCar(
                          false
                        )

                        setSelectedSpaces([])
                      }}
                    >
                      <span className="space-label">
                        {space.label}
                      </span>

                      {vehicle &&
                        draggingVehicle?.id !==
                          vehicle.id && (
                          <div
                            className="car"
                            onMouseDown={(
                              event
                            ) => {
                              startVehicleDrag(
                                event,
                                vehicle
                              )
                            }}
                            onClick={(
                              event
                            ) => {
                              event.stopPropagation()

                              if (
                                justFinishedSelecting.current
                              ) {
                                justFinishedSelecting.current =
                                  false

                                return
                              }

                              setShowAddCar(
                                false
                              )

                              setSelectedVehicle(
                                vehicle.id
                              )

                              setSelectedSpace(
                                null
                              )

                              setSelectedSpaces(
                                []
                              )
                            }}
                          >
                            <div className="car-square">
                              <span className="car-square-vin">
                                {vehicle.vin
                                  ? formatVinBare(vehicle.vin)
                                  : 'NO VIN'}
                              </span>

                              <span>
                                {
                                  vehicle.registration ||
                                  'NO REGISTRATION'
                                }
                              </span>

                              <span>
                                {
                                  vehicle.make ||
                                  'NO MAKE / MODEL'
                                }
                              </span>
                            </div>
                          </div>
                        )}
                    </div>
                  )
                }
              )}

              {visibleLabels.map((label) => {
                const labelWidth =
                  label.width || 84

                const labelHeight =
                  label.height || 32

                const isLabelSelected =
                  selectedLabel === label.id

                return (
                  <div
                    key={label.id}
                    className={
                      'map-label' +
                      (isLabelSelected
                        ? ' selected'
                        : '')
                    }
                    style={{
                      left: label.x,
                      top: label.y,
                      width: labelWidth,
                      height: labelHeight,
                      transform: `rotate(${
                        label.rotation || 0
                      }deg)`,
                      fontSize:
                        computeLabelFontSize(
                          labelWidth,
                          labelHeight,
                          label.text
                        ),
                      cursor: showToolsPanel
                        ? 'grab'
                        : 'default',
                    }}
                    onMouseDown={(event) =>
                      startLabelDrag(
                        event,
                        label
                      )
                    }
                    onClick={(event) => {
                      if (!showToolsPanel) {
                        return
                      }

                      event.stopPropagation()

                      if (
                        justFinishedSelecting.current
                      ) {
                        justFinishedSelecting.current =
                          false

                        return
                      }

                      setSelectedLabel(label.id)
                      setSelectedSpace(null)
                      setSelectedArea(null)
                      setSelectedRoad(null)
                      setSelectedVehicle(null)
                      setSelectedSpaces([])
                      setShowAddCar(false)
                    }}
                  >
                    {label.text}
                  </div>
                )
              })}

              {showToolsPanel &&
                selectedLabelData &&
                [
                  { corner: 'nw', cx: 0, cy: 0 },
                  { corner: 'ne', cx: 1, cy: 0 },
                  { corner: 'sw', cx: 0, cy: 1 },
                  { corner: 'se', cx: 1, cy: 1 },
                ].map((handle) => (
                  <div
                    key={handle.corner}
                    className={
                      'resize-handle resize-handle-' +
                      handle.corner
                    }
                    style={{
                      left:
                        selectedLabelData.x +
                        (selectedLabelData.width ||
                          84) *
                          handle.cx,
                      top:
                        selectedLabelData.y +
                        (selectedLabelData.height ||
                          32) *
                          handle.cy,
                    }}
                    onMouseDown={(event) =>
                      startLabelResize(
                        event,
                        selectedLabelData,
                        handle.corner
                      )
                    }
                  />
                ))}

              <svg
                className="custom-object-layer"
                style={{
                  position: 'absolute',
                  left: -5000,
                  top: -5000,
                  width: 10000,
                  height: 10000,
                  pointerEvents: 'none',
                  overflow: 'visible',
                }}
                viewBox="-5000 -5000 10000 10000"
              >
                {visibleCustomObjects.map((obj) => {
                  const isSelected =
                    obj.id ===
                    selectedCustomObject

                  const color =
                    obj.color ||
                    OBJECT_COLORS[0]

                  const pointsAttr = obj.points
                    .map(
                      (point) =>
                        `${point.x},${point.y}`
                    )
                    .join(' ')

                  return (
                    <polygon
                      key={obj.id}
                      points={pointsAttr}
                      fill={hexToRgba(
                        isSelected
                          ? '#3d6f9d'
                          : color,
                        isSelected
                          ? 0.18
                          : 0.16
                      )}
                      stroke={
                        isSelected
                          ? '#3d6f9d'
                          : color
                      }
                      strokeWidth={isSelected ? 2.5 : 2}
                      style={{
                        pointerEvents: 'auto',
                        cursor: showToolsPanel
                          ? 'grab'
                          : 'default',
                      }}
                      onMouseDown={(event) =>
                        startCustomObjectDrag(
                          event,
                          obj
                        )
                      }
                      onClick={(event) => {
                        event.stopPropagation()
                      }}
                    />
                  )
                })}

                {drawingCustomObject && (
                  <>
                    <polyline
                      points={
                        drawingCustomObject.points
                          .concat(
                            customObjectPreviewPos
                              ? [
                                  customObjectPreviewPos,
                                ]
                              : []
                          )
                          .map(
                            (point) =>
                              `${point.x},${point.y}`
                          )
                          .join(' ')
                      }
                      fill="none"
                      stroke="#3d6f9d"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                    />

                    {drawingCustomObject.points.map(
                      (point, index) => (
                        <circle
                          key={index}
                          cx={point.x}
                          cy={point.y}
                          r={
                            index === 0 ? 7 : 4.5
                          }
                          fill={
                            index === 0
                              ? '#3d6f9d'
                              : '#ffffff'
                          }
                          stroke="#3d6f9d"
                          strokeWidth={2}
                        />
                      )
                    )}
                  </>
                )}

                {showToolsPanel &&
                  selectedCustomObjectData &&
                  selectedCustomObjectData.points.map(
                    (point, index) => (
                      <circle
                        key={index}
                        cx={point.x}
                        cy={point.y}
                        r={6}
                        fill="#ffffff"
                        stroke="#3d6f9d"
                        strokeWidth={2}
                        style={{
                          pointerEvents: 'auto',
                          cursor: 'grab',
                        }}
                        onMouseDown={(event) =>
                          startVertexDrag(
                            event,
                            selectedCustomObjectData,
                            index
                          )
                        }
                      />
                    )
                  )}
              </svg>

              {selectionBox && (
                <div
                  className="selection-box"
                  style={{
                    left:
                      Math.min(
                        selectionBox.startX,
                        selectionBox.endX
                      ),

                    top:
                      Math.min(
                        selectionBox.startY,
                        selectionBox.endY
                      ),

                    width:
                      Math.abs(
                        selectionBox.endX -
                          selectionBox.startX
                      ),

                    height:
                      Math.abs(
                        selectionBox.endY -
                          selectionBox.startY
                      ),
                  }}
                />
              )}

              {draggingVehicle &&
                previewPosition && (
                  <div
                    className="car dragging-car"
                    style={{
                      left:
                        previewPosition.x,

                      top:
                        previewPosition.y,
                    }}
                  >
                    <div className="car-square">
                      <span className="car-square-vin">
                        {
                          selectedVehicleData?.vin
                            ? formatVinBare(selectedVehicleData.vin)
                            : 'NO VIN'
                        }
                      </span>

                      <span>
                        {
                          selectedVehicleData?.registration ||
                          'NO REGISTRATION'
                        }
                      </span>

                      <span>
                        {
                          selectedVehicleData?.make ||
                          'NO MAKE / MODEL'
                        }
                      </span>
                    </div>
                  </div>
                )}
            </div>

            {showToolsPanel && (
              <button
                className="canvas-status"
                onClick={toggleEditMode}
              >
                <span className="online-dot" />

                Editing
              </button>
            )}

            {showToolsPanel && (
              <div className="history-controls">
                <button
                  onClick={undo}
                  disabled={past.length === 0}
                  title="Undo (Cmd/Ctrl+Z)"
                >
                  ↶
                </button>

                <button
                  onClick={redo}
                  disabled={future.length === 0}
                  title="Redo (Cmd/Ctrl+Shift+Z)"
                >
                  ↷
                </button>
              </div>
            )}

            <div className="yard-title lot-tabs">
              {lots.map((lot) =>
                renamingLotId === lot.id ? (
                  <input
                    key={lot.id}
                    type="text"
                    value={lot.name}
                    onChange={renameLot}
                    onBlur={() =>
                      setRenamingLotId(null)
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key ===
                          'Enter' ||
                        event.key === 'Escape'
                      ) {
                        setRenamingLotId(null)
                      }
                    }}
                    className="lot-tab-input"
                    autoFocus
                  />
                ) : (
                  <button
                    key={lot.id}
                    className={
                      'lot-tab' +
                      (lot.id === activeLotId
                        ? ' active'
                        : '')
                    }
                    onClick={() =>
                      switchLot(lot.id)
                    }
                    onDoubleClick={() =>
                      setRenamingLotId(lot.id)
                    }
                  >
                    {lot.name}
                  </button>
                )
              )}

              {showToolsPanel && (
                <button
                  className="lot-tab-add"
                  onClick={addLot}
                  title="Add a new lot"
                >
                  +
                </button>
              )}
            </div>

            <div className="zoom-controls">
              <button
                onClick={() =>
                  zoomBy(0.1)
                }
              >
                +
              </button>

              <div className="zoom-value">
                {Math.round(
                  (zoom /
                    ZOOM_DISPLAY_REFERENCE) *
                    100
                )}
                %
              </div>

              <button
                onClick={() =>
                  zoomBy(-0.1)
                }
              >
                −
              </button>
            </div>

            <div className="status-legend">
              <button
                className={
                  'status-legend-toggle' +
                  (showStatusLegend
                    ? ' active'
                    : '')
                }
                onClick={() =>
                  setShowStatusLegend(
                    (current) => !current
                  )
                }
                title="Status legend"
              >
                <div className="status-legend-ring">
                  {STATUS_LEGEND.map(
                    (item, index) => {
                      const angle =
                        (index /
                          STATUS_LEGEND.length) *
                          2 *
                          Math.PI -
                        Math.PI / 2

                      const radius = 10

                      const x =
                        Math.cos(angle) *
                        radius

                      const y =
                        Math.sin(angle) *
                        radius

                      return (
                        <span
                          key={item.value}
                          className="status-legend-dot"
                          style={{
                            background:
                              item.color,
                            left: `calc(50% + ${x}px)`,
                            top: `calc(50% + ${y}px)`,
                          }}
                        />
                      )
                    }
                  )}
                </div>
              </button>

              {showStatusLegend && (
                <div className="status-legend-panel">
                  {STATUS_LEGEND.map(
                    (item) => (
                      <div
                        key={item.value}
                        className="status-legend-row"
                      >
                        <span
                          className="status-legend-swatch"
                          style={{
                            background:
                              item.color,
                          }}
                        />

                        {item.label}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </div>

          {showSettingsPanel && (
            <SettingsPanel
              organization={organization}
              membership={membership}
              userId={session.user.id}
              onClose={() =>
                setShowSettingsPanel(false)
              }
              onLeft={() => {
                setShowSettingsPanel(false)
                loadMembership(session.user.id)
              }}
            />
          )}

          {showAddCar && addCarAnchor && (
            <aside
              className="inspector add-car-popover"
              style={{
                top: addCarAnchor.top,
                bottom: addCarAnchor.bottom,
                left: addCarAnchor.left,
                maxHeight:
                  addCarAnchor.top !==
                  undefined
                    ? `calc(100vh - ${addCarAnchor.top}px - 20px)`
                    : `calc(100vh - ${addCarAnchor.bottom}px - 20px)`,
              }}
            >
              <div className="inspector-header">
                <div>
                  <span className="inspector-eyebrow">
                    VEHICLE
                  </span>

                  <h2>
                    {newCarRows.length > 1
                      ? `Add ${newCarRows.length} cars`
                      : 'Add new car'}
                  </h2>
                </div>

                <button
                  className="close-button"
                  onClick={() =>
                    setShowAddCar(
                      false
                    )
                  }
                >
                  ×
                </button>
              </div>

              <div className="add-car-rows">
                {newCarRows.map(
                  (row, index) => (
                    <div
                      key={row.id}
                      className="add-car-row"
                    >
                      <div className="add-car-row-header">
                        <span>
                          CAR{' '}
                          {index + 1}
                        </span>

                        {newCarRows.length >
                          1 && (
                          <button
                            className="remove-row-button"
                            onClick={() =>
                              removeCarRow(
                                row.id
                              )
                            }
                          >
                            ×
                          </button>
                        )}
                      </div>

                      <input
                        className="space-name-input add-car-row-input"
                        type="text"
                        placeholder="VIN"
                        value={row.vin}
                        onChange={(event) =>
                          updateCarRow(
                            row.id,
                            'vin',
                            event.target
                              .value
                          )
                        }
                      />

                      <input
                        className="space-name-input add-car-row-input"
                        type="text"
                        placeholder="Registration, e.g. ABC123"
                        value={
                          row.registration
                        }
                        onChange={(event) =>
                          updateCarRow(
                            row.id,
                            'registration',
                            event.target
                              .value
                          )
                        }
                      />

                      <input
                        className="space-name-input add-car-row-input"
                        type="text"
                        placeholder="Make & model"
                        value={row.make}
                        onChange={(event) =>
                          updateCarRow(
                            row.id,
                            'make',
                            event.target
                              .value
                          )
                        }
                      />

                      <select
                        className="space-name-input add-car-row-input add-car-row-status"
                        value={
                          row.status
                        }
                        onChange={(event) =>
                          updateCarRow(
                            row.id,
                            'status',
                            event.target
                              .value
                          )
                        }
                      >
                        <option value="reserved">
                          Reserved
                        </option>

                        <option value="sold">
                          Sold
                        </option>

                        <option value="waiting-pdi">
                          Waiting for PDI
                        </option>

                        <option value="waiting-cleaning">
                          Waiting for cleaning
                        </option>

                        <option value="cleaned">
                          Cleaned
                        </option>

                        <option value="ready">
                          Ready for delivery
                        </option>

                        <option value="demo">
                          Demo
                        </option>

                        <option value="test-drive">
                          Test drive
                        </option>
                      </select>
                    </div>
                  )
                )}
              </div>

              <div className="add-car-actions">
                <button
                  className="add-car-cancel"
                  onClick={() =>
                    setShowAddCar(
                      false
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  className="add-car-button"
                  onClick={addNewCar}
                >
                  {newCarRows.length > 1
                    ? `Add ${newCarRows.length} cars`
                    : 'Add car'}
                </button>
              </div>

              <button
                className="add-row-button"
                onClick={addCarRow}
              >
                + Add another car
              </button>
            </aside>
          )}

          {(selectedVehicleData ||
            selectedSpaceData ||
            selectedAreaData ||
            selectedRoadData ||
            selectedLabelData ||
            selectedCustomObjectData ||
            selectedSpaces.length > 1) && (
            <aside className="inspector">
              {selectedSpaces.length > 1 ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        PARKING SPACES
                      </span>

                      <h2>
                        {
                          selectedSpaces.length
                        }{' '}
                        selected
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="detail-group">
                    <label>
                      ROTATION
                    </label>

                    <button
                      className="rotate-space-button"
                      onClick={
                        rotateSelectedSpaces
                      }
                    >
                      ⟳ Rotate all 45°
                    </button>
                  </div>

                  <div className="inspector-actions">
                    <button
                      className="delete-button"
                      onClick={
                        deleteSelectedSpaces
                      }
                    >
                      Delete selected
                    </button>
                  </div>
                </>
              ) : selectedVehicleData ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        VEHICLE
                      </span>

                      <h2>
                        {
                          selectedVehicleData.vin
                            ? formatVinShort(selectedVehicleData.vin)
                            : 'NO VIN'
                        }
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="vehicle-card">
                    <div className="vehicle-card-registration">
                      {
                        selectedVehicleData.vin
                          ? formatVinShort(selectedVehicleData.vin)
                          : 'NO VIN'
                      }
                    </div>

                    <div className="vehicle-card-make">
                      {
                        selectedVehicleData.make ||
                        'NO MAKE / MODEL'
                      }
                    </div>
                  </div>

                  <div className="detail-group">
                    <label>
                      VIN NUMBER
                    </label>

                    <div className="detail-value vin">
                      {
                        selectedVehicleData.vin ||
                        'NO VIN'
                      }
                    </div>
                  </div>

                  <div className="detail-group">
                    <label>
                      REGISTRATION NUMBER
                    </label>

                    <div className="detail-value">
                      {
                        selectedVehicleData.registration ||
                        'NO REGISTRATION'
                      }
                    </div>
                  </div>

                  <div className="detail-group">
                    <label>
                      MAKE & MODEL
                    </label>

                    <div className="detail-value">
                      {
                        selectedVehicleData.make ||
                        'NO MAKE / MODEL'
                      }
                    </div>
                  </div>

                  <div className="detail-group">
                    <label>
                      STATUS
                    </label>

                    <select
                      className="space-name-input"
                      value={
                        selectedVehicleData.status
                      }
                      onChange={
                        updateVehicleStatus
                      }
                    >
                      <option value="reserved">
                        Reserved
                      </option>

                      <option value="sold">
                        Sold
                      </option>

                      <option value="waiting-pdi">
                        Waiting for PDI
                      </option>

                      <option value="waiting-cleaning">
                        Waiting for cleaning
                      </option>

                      <option value="cleaned">
                        Cleaned
                      </option>

                      <option value="ready">
                        Ready for delivery
                      </option>

                      <option value="demo">
                        Demo
                      </option>

                      <option value="test-drive">
                        Test drive
                      </option>
                    </select>
                  </div>

                  <div className="vehicle-actions">
                    {selectedVehicleData.spaceId !==
                      null && (
                      <button
                        className="unassign-button"
                        onClick={
                          moveVehicleToUnassigned
                        }
                      >
                        Unassign
                      </button>
                    )}

                    <button
                      className="delete-button"
                      onClick={
                        deleteVehicle
                      }
                    >
                      Delete
                    </button>
                  </div>
                </>
              ) : selectedSpaceData ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        PARKING SPACE
                      </span>

                      <h2>
                        {
                          selectedSpaceData.label
                        }
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="space-preview">
                    <span>
                      {
                        selectedSpaceData.label
                      }
                    </span>
                  </div>

                  <div className="detail-group">
                    <label>
                      SPACE NAME
                    </label>

                    <input
                      type="text"
                      value={
                        selectedSpaceData.label
                      }
                      onChange={
                        updateSpaceName
                      }
                      readOnly={
                        !isRenamingSpace
                      }
                      className={
                        'space-name-input' +
                        (!isRenamingSpace
                          ? ' read-only'
                          : '')
                      }
                      autoFocus={
                        isRenamingSpace
                      }
                    />

                    {!isRenamingSpace && (
                      <div className="field-hint">
                        Double-click the space on the map to rename it
                      </div>
                    )}
                  </div>

                  <div className="detail-group">
                    <label>
                      ROTATION
                    </label>

                    <button
                      className="rotate-space-button"
                      onClick={() =>
                        rotateSpace(
                          selectedSpaceData.id
                        )
                      }
                    >
                      ⟳ Rotate 45°
                    </button>
                  </div>

                  <div className="inspector-actions">
                    {selectedSpaceVehicle ? (
                      <div className="field-hint">
                        This space has a car
                        parked in it. Unassign
                        the car before deleting
                        the space.
                      </div>
                    ) : (
                      <button
                        className="delete-button"
                        onClick={
                          deleteSelectedSpaces
                        }
                      >
                        Delete space
                      </button>
                    )}
                  </div>
                </>
              ) : selectedAreaData ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        OBJECT
                      </span>

                      <h2>
                        {
                          selectedAreaData.label
                        }
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="detail-group">
                    <label>
                      OBJECT NAME
                    </label>

                    <input
                      type="text"
                      value={
                        selectedAreaData.label
                      }
                      onChange={
                        updateAreaName
                      }
                      onFocus={
                        pushHistory
                      }
                      className="space-name-input"
                      autoFocus
                    />
                  </div>

                  <div className="detail-group">
                    <label>
                      COLOR
                    </label>

                    <div className="color-swatches">
                      {OBJECT_COLORS.map(
                        (color) => (
                          <button
                            key={color}
                            className={
                              'color-swatch' +
                              (selectedAreaData.color ===
                              color
                                ? ' active'
                                : '')
                            }
                            style={{
                              background:
                                color,
                            }}
                            onClick={() =>
                              updateAreaColor(
                                color
                              )
                            }
                          />
                        )
                      )}
                    </div>
                  </div>

                  <div className="inspector-actions">
                    <button
                      className="delete-button"
                      onClick={deleteArea}
                    >
                      Delete object
                    </button>
                  </div>
                </>
              ) : selectedRoadData ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        ROAD
                      </span>

                      <h2>
                        Road segment
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="field-hint">
                    Purely visual, helps with
                    orientation on the map. Drag
                    to move, or delete below.
                  </div>

                  <div className="inspector-actions">
                    <button
                      className="delete-button"
                      onClick={deleteRoad}
                    >
                      Delete road
                    </button>
                  </div>
                </>
              ) : selectedLabelData ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        LABEL
                      </span>

                      <h2>
                        {
                          selectedLabelData.text
                        }
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="detail-group">
                    <label>
                      LABEL TEXT
                    </label>

                    <input
                      type="text"
                      value={
                        selectedLabelData.text
                      }
                      onChange={
                        updateLabelText
                      }
                      onFocus={
                        pushHistory
                      }
                      className="space-name-input"
                      autoFocus
                    />
                  </div>

                  <div className="detail-group">
                    <label>
                      ROTATION
                    </label>

                    <button
                      className="rotate-space-button"
                      onClick={() =>
                        rotateLabel(
                          selectedLabelData.id
                        )
                      }
                    >
                      ⟳ Rotate 45°
                    </button>
                  </div>

                  <div className="inspector-actions">
                    <button
                      className="delete-button"
                      onClick={deleteLabel}
                    >
                      Delete label
                    </button>
                  </div>
                </>
              ) : selectedCustomObjectData ? (
                <>
                  <div className="inspector-header">
                    <div>
                      <span className="inspector-eyebrow">
                        CUSTOM OBJECT
                      </span>

                      <h2>
                        {
                          selectedCustomObjectData.label
                        }
                      </h2>
                    </div>

                    <button
                      className="close-button"
                      onClick={
                        closeInspector
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="detail-group">
                    <label>
                      OBJECT NAME
                    </label>

                    <input
                      type="text"
                      value={
                        selectedCustomObjectData.label
                      }
                      onChange={
                        updateCustomObjectLabel
                      }
                      onFocus={
                        pushHistory
                      }
                      className="space-name-input"
                      autoFocus
                    />
                  </div>

                  <div className="detail-group">
                    <label>
                      COLOR
                    </label>

                    <div className="color-swatches">
                      {OBJECT_COLORS.map(
                        (color) => (
                          <button
                            key={color}
                            className={
                              'color-swatch' +
                              (selectedCustomObjectData.color ===
                              color
                                ? ' active'
                                : '')
                            }
                            style={{
                              background:
                                color,
                            }}
                            onClick={() =>
                              updateCustomObjectColor(
                                color
                              )
                            }
                          />
                        )
                      )}
                    </div>
                  </div>

                  <div className="field-hint">
                    Drag the shape to move it, or
                    drag any corner point to
                    reshape it.
                  </div>

                  <div className="inspector-actions">
                    <button
                      className="delete-button"
                      onClick={
                        deleteCustomObject
                      }
                    >
                      Delete object
                    </button>
                  </div>
                </>
              ) : null}
            </aside>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
