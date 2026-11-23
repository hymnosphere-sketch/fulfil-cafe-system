export function demoStorageNotice(storageMode) {
  if (storageMode === 'integration') {
    return 'These fictional changes are saved in this browser. Use Synchronize now in Settings to send pending work to the disposable Flask fixture.'
  }
  if (storageMode === 'isolated') {
    return 'This isolated demonstration uses a temporary copy in this tab. Refreshing starts a new temporary session.'
  }
  return 'Changes are saved in this browser and remain after refresh. Clearing browser data or losing storage can remove local records. Server synchronization and backups are not configured.'
}
