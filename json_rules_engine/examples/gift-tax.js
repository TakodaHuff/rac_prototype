'use strict'
const { Engine } = require('json-rules-engine')

async function start () {
  // Setup a new engine
  const engine = new Engine()

  // Rule 1: Gift tax 30%
  engine.addRule({
    name: 'Gift-Tax-30',
    conditions: {
      all: [
        {
          fact: 'type',
          operator: 'equal',
          value: 'gift'
        },
        {
          fact: 'amount',
          operator: 'greaterThan',
          value: 500
        },
        {
          fact: 'amount',
          operator: 'lessThanInclusive',
          value: 1500
        }
      ]
    },
    event: {
      type: 'gift-tax-30',
      params: {
        taxRate: 0.30,
        message: 'Gift amount > 500 and <= 1500 so taxed at 30%'
      }
    }
  })

  // Rule 2: Gift tax 40%
  engine.addRule({
    name: 'Gift-Tax-40',
    conditions: {
      all: [
        {
          fact: 'type',
          operator: 'equal',
          value: 'gift'
        },
        {
          fact: 'amount',
          operator: 'greaterThan',
          value: 1500
        }
      ]
    },
    event: {
      type: 'gift-tax-40',
      params: {
        taxRate: 0.40,
        message: 'Gift amount > 1500 so taxed at 40%'
      }
    }
  })

  // Rule 3: No tax
  engine.addRule({
    name: 'No-Tax',
    conditions: {
      any: [
        {
          fact: 'type',
          operator: 'notEqual',
          value: 'gift'
        },
        {
          fact: 'amount',
          operator: 'lessThanInclusive',
          value: 500
        }
      ]
    },
    event: {
      type: 'no-tax',
      params: {
        taxRate: 0.0,
        message: 'Not a gift OR amount <= 500 so no tax'
      }
    }
  })

  // Define facts (example)
  const facts = {
    type: 'gift',
    amount: 1200
  }

  // Run engine
  engine
    .run(facts)
    .then(results => {
      results.events.map(event => console.log(event.params.message, '| Tax Rate:', event.params.taxRate))
    })
    .catch(err => console.error(err))
}

// call start()
start()
