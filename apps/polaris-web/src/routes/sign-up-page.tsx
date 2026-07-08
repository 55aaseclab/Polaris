import { useAuth } from "@clerk/react";
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { portalSignUpUrl } from "@/lib/portal-auth";

export default function SignUpPage() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded && userId) {
      return;
    }
    window.location.assign(portalSignUpUrl());
  }, [isLoaded, userId]);

  if (isLoaded && userId) {
    return <Navigate to="/" replace />;
  }
  return null;
}
