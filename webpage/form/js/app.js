document.addEventListener('alpine:init', () => {
    Alpine.data('formApp', () => ({
        currentStep: 0,
        prevStep: 0,
        steps: formSteps, // state.js

        nextStep() {
            if (this.currentStep < this.steps.length) {
                this.currentStep++;
            }
        },

        jumpTo(i) {
            this.prevStep = this.currentStep;
            this.currentStep = i;
        },

        // Transition of sub-steps / modes
        setMode(i, newMode) {
            this.steps[i].mode = newMode;
        },

        // Transition between steps
        markCompleteAndAdvance(i) {
            this.steps[i].completed = true;
            this.steps[i].value = `(dummy ${this.steps[i].key} value)`;
            this.nextStep();
        },

        cancelLogout(i) {
            this.currentStep = this.prevStep;
        },

        nodeClasses(i) {
            const step = this.steps[i];

            if (i === this.currentStep) {
                return 'w-full max-h-[75vh] rounded-[2rem] bg-blue-50 border border-blue-200 p-4';
            }

            if (step.completed) {
                return 'inline-flex flex-col rounded-md bg-blue-500 text-white px-3 py-2 max-w-full';
            }

            // incomplet
            return 'w-10 h-10 rounded-[2rem] bg-gray-300';
        },
    }));
});