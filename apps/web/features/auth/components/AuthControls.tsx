"use client";

import { Show, UserButton, useClerk } from "@clerk/nextjs";

export function AuthControls() {
  const clerk = useClerk();

  function signIn() {
    const returnUrl = window.location.href;
    clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
  }

  function signUp() {
    const returnUrl = window.location.href;
    clerk.openSignUp({ forceRedirectUrl: returnUrl, signInForceRedirectUrl: returnUrl });
  }

  return (
    <div className="auth-controls" aria-label="Account">
      <Show when="signed-out">
        <button className="auth-button" type="button" onClick={signIn}>Sign in</button>
        <button className="auth-button primary" type="button" onClick={signUp}>Create account</button>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  );
}
