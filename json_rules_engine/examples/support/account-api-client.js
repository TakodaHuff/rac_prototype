module.exports = {
  getAccountInformation: async function (accountId) {
    // Fake async API response for testing
    return new Promise((resolve) => {
      setTimeout(() => {
        if (accountId === 'lincoln') {
          resolve({
            company: 'microsoft',           // Must match microsoftRule condition
            status: 'active',               // Must be 'active' or 'paid-leave'
            ptoDaysTaken: ['2016-12-25']    // Must contain '2016-12-25'
          })
        } else {
          // default fallback data
          resolve({
            company: 'unknown',
            status: 'inactive',
            ptoDaysTaken: []
          })
        }
      }, 200)
    })
  }
}