import { useAuth, useAuthing } from "@/lib/authing";
import { useEffect } from "react";
import { Navigate } from "react-router-dom";

export default function SignUpPage() {
  const { isLoaded, userId } = useAuth();
  const { signIn } = useAuthing();
  useEffect(() => {
    if (isLoaded && userId) {
      return;
    }
    signIn("sign-up");
  }, [isLoaded, signIn, userId]);

  if (isLoaded && userId) {
    return <Navigate to="/" replace />;
  }
  return null;
}
