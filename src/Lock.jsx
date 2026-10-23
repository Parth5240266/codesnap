import { useState } from 'react'

export const LockIcon = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d={open ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
  </svg>
)

// Full-page prompt shown when the room has a passkey we haven't entered.
export function LockScreen({ room, error, onSubmit, onNewRoom }) {
  const [passkey, setPasskey] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!passkey || busy) return
    setBusy(true)
    await onSubmit(passkey, remember)
    setBusy(false)
  }

  return (
    <div className="lockscreen">
      <form className="card" onSubmit={submit}>
        <span className="lockbadge"><LockIcon /></span>
        <h2>This page is private</h2>
        <p>
          <code>/{room}</code> is protected with a passkey. Enter it to see the text and files.
        </p>
        <input
          type="password"
          autoFocus
          placeholder="Passkey"
          value={passkey}
          onChange={(e) => setPasskey(e.target.value)}
        />
        <label className="remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this device for 30 days
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={!passkey || busy}>Unlock</button>
        <button type="button" className="link" onClick={onNewRoom}>Start a new page instead</button>
      </form>
    </div>
  )
}

// Toolbar popover to set, change or remove the room's passkey.
export function LockPopover({ locked, onLock, onUnlock, onSignOut }) {
  const [passkey, setPasskey] = useState('')
  const [confirm, setConfirm] = useState('')
  const [changing, setChanging] = useState(!locked)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const tooShort = passkey.length < 4
  const mismatch = confirm && passkey !== confirm

  const submit = async (e) => {
    e.preventDefault()
    if (tooShort || passkey !== confirm) return
    const err = await onLock(passkey, remember)
    setError(err || '')
    if (err) return
    setPasskey('')
    setConfirm('')
    setChanging(false)
  }

  if (locked && !changing) {
    return (
      <div className="lockpop">
        <strong>This page is private</strong>
        <p>Visitors need the passkey to see the text and files.</p>
        <div className="row">
          <button onClick={() => setChanging(true)}>Change passkey</button>
          <button onClick={onUnlock}>Remove lock</button>
        </div>
        <button className="link" onClick={onSignOut}>Sign out on this device</button>
      </div>
    )
  }

  return (
    <form className="lockpop" onSubmit={submit}>
      <strong>{locked ? 'Change passkey' : 'Make this page private'}</strong>
      <p>
        Anyone opening this link will need the passkey.
        {locked ? ' Everyone else will be signed out.' : ''} There is no way to recover a forgotten passkey.
      </p>
      <input
        type="password"
        autoFocus
        placeholder="Passkey (at least 4 characters)"
        value={passkey}
        onChange={(e) => setPasskey(e.target.value)}
      />
      <input
        type="password"
        placeholder="Confirm passkey"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {mismatch && <p className="error">Passkeys don't match</p>}
      <label className="remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember this device for 30 days
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit" disabled={tooShort || passkey !== confirm}>
        {locked ? 'Save passkey' : 'Lock page'}
      </button>
    </form>
  )
}
