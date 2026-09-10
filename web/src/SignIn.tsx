export function SignIn() {
  return (
    <div className="settings-screen">
      <h1>SmashSet</h1>
      <p className="subtitle">Fast set reporting for start.gg TOs</p>
      <button
        onClick={() => {
          // A full navigation, not a fetch — the user needs to land on
          // start.gg's own login/consent screen, not just call an API.
          window.location.href = '/api/auth/login';
        }}
      >
        Sign in with start.gg
      </button>
    </div>
  );
}
