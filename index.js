// Be sure to add these ENV variables!
const {
  KEYGEN_PRODUCT_TOKEN,
  KEYGEN_ACCOUNT_ID,
  KEYGEN_POLICY_ID,
  PORT = 4000
} = process.env

const crypto = require('crypto')
const fetch = require('node-fetch')
const express = require('express')
const bodyParser = require('body-parser')
const morgan = require('morgan')
const app = express()

app.use(bodyParser.urlencoded({ extended: false }))
app.use(morgan('combined'))

app.post('/generate', async (req, res) => {
  const { order } = req.body

  // Since this route should only be accessed after a successful order,
  // we should verify that the passed order is valid -- this helps defend
  // against somebody accessing this route directly to generate free
  // license keys.
  if (!order) {
    return res.status(400).send('Order ID is required for generating new licenses')
  }

  // TODO: Verify the order actually happened, and that this request is
  //       coming from e.g. our payment provider.

  // Generate a short license key that can be easily input by-hand.
  const key = crypto.randomBytes(8).toString('hex').split(/(.{4})/).filter(Boolean).join('-')

  // Create a new license key.
  const response = await fetch(`https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEYGEN_PRODUCT_TOKEN}`,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      data: {
        type: 'licenses',
        attributes: {
          key
        },
        relationships: {
          policy: {
            data: { type: 'policies', id: KEYGEN_POLICY_ID }
          },
          // If you're associating the license with a specific user, uncomment this line
          // and provide their user ID:
          // user: {
          //   data: { type: 'users', id: user }
          // }
        }
      }
    })
  })

  const { data, errors } = await response.json()

  // Check if we received an error from Keygen.
  if (errors) {
    return res.status(500).send(errors.map(e => e.detail).join(', '))
  }

  // All is good -- license was successfully created. Here, you may
  // want to adjust the response below to meet your payment provider's
  // requirements, i.e. plaintext vs JSON response, status code, etc.
  // You may also want to email the user a copy of their license key,
  // so that they can move onto the activation step.
  res.status(200).send(data.attributes.key)
})

app.post('/activate', async (req, res) => {
  const { fingerprint, key } = req.body

  // This route is accessed from within the product, and is used to activate
  // a single machine for a given license key. We'll be identifying each
  // machine by a "fingerprint" -- which can be anything from a user's
  // hash of the MAC address, to a randomly generated UUID stored in
  // an easily accessible location i.e. file-system, registry, etc.
  if (!fingerprint) {
    return res.status(400).send('Machine fingerprint is required for license activation')
  }

  // First, we need to validate the provided license key within the scope
  // of the provided fingerprint.
  if (!key) {
    return res.status(400).send('License key is required for license activation')
  }

  // Validate the license key.
  const validation = await fetch(`https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses/actions/validate-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      meta: {
        scope: { fingerprint },
        key
      }
    })
  })

  const { meta, data: license, errors: errs1 } = await validation.json()

  // Check if we received an error from Keygen during validation.
  if (errs1) {
    return res.status(500).send(errs1.map(e => e.detail).join(', '))
  }

  // If the license is invalid, exit early, *unless* the license is only
  // invalid because it does not have any machine activations yet.
  if (!meta.valid) {
    switch (meta.constant) {
      case 'FINGERPRINT_SCOPE_MISMATCH': // Allow more than 1 activation if our license isn't node-locked
      case 'NO_MACHINES':
      case 'NO_MACHINE': {
        break
      }
      default: {
        return res.status(422).send(`The license ${meta.detail}`)
      }
    }
  }

  // License is valid -- activate the current machine.
  const activation = await fetch(`https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/machines`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEYGEN_PRODUCT_TOKEN}`,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      data: {
        type: 'machines',
        attributes: {
          fingerprint
        },
        relationships: {
          license: {
            data: { type: 'licenses', id: license.id }
          }
        }
      }
    })
  })

  const { data: machine, errors: errs2 } = await activation.json()

  // Check if we received an error from Keygen during activation.
  if (errs2) {
    return res.status(500).send(errs2.map(e => e.detail).join(', '))
  }

  // All is good -- machine was successfully activated. Here, you may
  // want to adjust the response below to meet your needs.
  res.status(200).send(`Machine ${machine.attributes.fingerprint} activated!`)
})

app.post('/validate', async (req, res) => {
  const { fingerprint, key } = req.body

  if (!fingerprint) {
    return res.status(400).send('Machine fingerprint is required for license validation')
  }

  if (!key) {
    return res.status(400).send('License key is required for license validation')
  }

  // Validate the provided license key within the scope of the user's
  // current machine.
  const validation = await fetch(`https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses/actions/validate-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      meta: {
        scope: { fingerprint },
        key
      }
    })
  })

  const { meta, errors } = await validation.json()

  // Check if we received an error from Keygen during validation.
  if (errors) {
    return res.status(500).send(errors.map(e => e.detail).join(', '))
  }

  if (!meta.valid) {
    return res.status(422).send(`The license ${meta.detail}`)
  }

  return res.status(200).send(`The license ${meta.detail}`)
})

process.on('unhandledRejection', err => {
  console.error(`Unhandled rejection: ${err}`, err.stack)
})

const server = app.listen(PORT, 'localhost', () => {
  const { address, port } = server.address()

  console.log(`Listening at http://${address}:${port}`)
})