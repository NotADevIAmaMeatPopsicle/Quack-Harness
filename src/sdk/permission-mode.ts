export interface SdkPermissionOptions {
  permissionMode: "acceptEdits" | "bypassPermissions";
  allowDangerouslySkipPermissions?: true;
}

export function getSdkPermissionOptions(): SdkPermissionOptions {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  if (isRoot) {
    return { permissionMode: "acceptEdits" };
  }

  return {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };
}
