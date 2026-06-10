const passwordHeader = 'x-admin-password'

export const isAdminRequest = (request: Request): boolean => {
  const expectedPassword = process.env.RANDO3D_ADMIN_PASSWORD
  const providedPassword = request.headers.get(passwordHeader)

  if (!expectedPassword || !providedPassword) return false

  return providedPassword === expectedPassword
}

export const hasAdminPassword = (): boolean => {
  return Boolean(process.env.RANDO3D_ADMIN_PASSWORD)
}
