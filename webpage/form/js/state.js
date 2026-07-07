const formSteps = [
    // completed: tracks progress
    // mode:      control current state of the card
    // value:     holds input data
    // editType:  edit | logout | null
    {
        key: 'auth',
        completed: false,
        mode: 'login',      // 'login' | 'logout'
        value: null,
        editType: 'logout', 
    },
    {
        key: 'pair',
        completed: false,
        mode: null,         // 'line' | 'patient'
        value: null,
        editType: 'edit',
    },
    {
        key: 'symptoms',
        completed: false,
        mode: null,
        value: null,
        editType: 'edit',
    },
    {
        key: 'review',
        completed: false,
        mode: null,
        value: null,
        editType: null,
    },
];

console.log('steps.js loaded.', formSteps);