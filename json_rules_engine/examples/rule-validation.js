'use strict'
const { Engine } = require('json-rules-engine')

async function start () {
  // Setup a new engine
  const engine = new Engine()

  // define a rule
  engine.addRule({
    name: 'Employee-Salary',
    conditions: {
      all: [
        {
          fact: 'designation',
          operator: 'equal',
          value: 'Manager'
        },
        {
          fact: 'experience',
          operator: 'greaterThan',
          value: 10
        }
      ]
    },
	// define the 'event' that will fire when the condition evaluates truthy
    event: { 
      type: 'high-salary',
      params: {
        message: 'Manager with more than 10 years experience gets $5000 salary'
      }
    }
  })

  // Define facts
  const facts = {
    designation: 'Manager',
    experience: 15
  }

  // Run engine
  engine
    .run(facts)
    .then(results => {
      results.events.map(event => console.log(event.params.message))
    })
    .catch(err => console.error(err))
}

// call start()
start()
