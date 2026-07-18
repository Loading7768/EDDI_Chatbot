const networkError = '伺服器連線失敗';

document.addEventListener('alpine:init', () => {
    Alpine.data('formApp', () => ({
        currentStep: 0,
        prevStep: 0,

        // state.js
        steps: initSteps(),
        STATUS,

        runWithNodeFlip(mutateFn) {
            const elements = [...document.querySelectorAll('[data-flip]')];
            window.flipAnimate(elements, mutateFn);
        },

        nextStep() {
            if (this.currentStep < this.steps.length) {
                this.runWithNodeFlip(() => {
                    this.currentStep++;
                });
            }
        },

        jumpTo(i) {
            this.runWithNodeFlip(() => {
                this.prevStep = this.currentStep;
                this.currentStep = i;
                this.edit = false;
            });
        },

        nodeClasses(i) {
            const step = this.steps[i];

            if (i === this.currentStep) {
                return 'w-full max-h-[72vh] p-4 rounded-[2rem] bg-slate-800';
            }

            if (step.completed) {
                return 'flex justify-center px-6 py-4 rounded-lg bg-blue-950';
            }

            // incomplet
            return 'w-10 h-10 p-4 ml-5 rounded-[2rem] bg-slate-900';
        },

        async delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },


        // ========== Auth Step ==========
        async confirmLogin() {
            const authStep = this.steps[0];
            authStep.error = null;
            authStep.currentStatus = STATUS.LOADING;

            try {
                const resp = await fetch('/api/form_login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        account: authStep.draft.account,
                        password: authStep.draft.password,
                    }),
                });
                const data = await resp.json();

                await this.delay(1000);
                if (!data.success) {
                    throw new Error(data.message);
                }
                authStep.currentStatus = STATUS.SUCCESS;

                await this.delay(300);
                authStep.draft = { account: '', password: '' };
                authStep.doctorName = data.doctor_name;
                authStep.doctorDept = data.doctor_department;
                authStep.completed = true;
                this.nextStep();
                authStep.authed = true;

            } catch (err) {
                authStep.error = err instanceof TypeError ? networkError : err.message;
            }

            authStep.currentStatus = STATUS.IDLE;
        },

        async confirmLogout() {
            const authStep = this.steps[0];
            authStep.error = '';
            authStep.currentStatus = STATUS.LOADING;

            try {
                const resp = await fetch('api/form_logout', { method: 'POST' });

                if(!resp) {
                    throw new Error(networkError);
                }
                
                await this.delay(1000);
                authStep.currentStatus = STATUS.SUCCESS;
                await this.delay(300);
                this.steps = initSteps();
                
            } catch (err) {
                authStep.error = err instanceof TypeError ? networkError : err.message;
            }

            authStep.currentStatus = STATUS.IDLE;
        },

        async cancelLogout() {
            this.runWithNodeFlip(() => {
                this.currentStep = this.prevStep;
            });
        },


        // ========== Pair Step ==========
        async confirmPair() {
            const step = this.steps[1];
            if (step.pairingCode.length < 6) return;

            step.currentStatus = STATUS.LOADING;
            step.error = '';

            try {
                const res = await fetch('/api/form_pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: step.pairingCode })
                });
                const data = await res.json();

                await this.delay(1000);
                if (!data.success) {
                    throw new Error(data.message);
                }

                step.currentStatus = STATUS.SUCCESS;
                await this.delay(300);
                step.lineUname = data.line_uname;
                step.lineUuid = data.line_uuid;
                step.savedRelations = data.relations || [];
                this.runWithNodeFlip(() => {
                    step.paired = true;
                });

                // Pre-processing for select patient
                step.hasSelf = step.savedRelations.some(r => r.relation === '帳號本人');
                if (!step.hasSelf) {
                    step.savedRelations.unshift({ relation: '帳號本人', medical_record_num: '' });
                }
                step.savedRelations.sort((a, b) => (a.relation === '帳號本人') ? -1 : (b.relation === '帳號本人') ? 1 : 0);
                
            } catch (err) {
                step.error = err instanceof TypeError ? networkError : err.message;
                step.pairingCode = '';
            }

            step.currentStatus = STATUS.IDLE;
        },

        async confirmPatient() {
            const step = this.steps[1];
            step.error = '';

            // Resolve relation input & validate
            if (step.selectedIdx == -1) { // new
                step.selectedRelation.relation = step.draft.new.relation.trim();
                step.selectedRelation.mrc = step.draft.new.mrc.trim();

                // Validate
                const isDup = step.savedRelations.some(
                    r => r.relation === step.selectedRelation.relation || r.medical_record_num === step.selectedRelation.mrc);
                if (isDup) {
                    step.error = '稱呼、病歷號不可重複';
                    return;
                }
            }else if(step.selectedIdx == 0 && !step.hasSelf) { // self input
                step.selectedRelation.relation = '帳號本人';
                step.selectedRelation.mrc = step.draft.self.mrc.trim();

                // Validate
                const isDup = step.savedRelations.some(r => r.medical_record_num === step.selectedRelation.mrc);
                if (isDup) {
                    step.error = '病歷號不可重複';
                    return;
                }
            }else { // select existing
                step.selectedRelation.relation = step.savedRelations[step.selectedIdx].relation;
                step.selectedRelation.mrc = step.savedRelations[step.selectedIdx].medical_record_num;

                // Get records
                let pastSymptoms = null;
                pastSymptoms = step.savedRelations[step.selectedIdx].prefilled_symptoms;
                // Prefill selection based on patient
                const symptomStep = this.steps[2];
                if (symptomStep.sessionLoaded) {
                    symptomStep.sessionLoaded = false;
                } else {
                    if (pastSymptoms) {
                        symptomStep.selectedSymptoms = [...pastSymptoms];
                        symptomStep.showPrefillMsg = true;
                    } else {
                        symptomStep.selectedSymptoms = [];
                        symptomStep.showPrefillMsg = false;
                    }
                }
            }

            // Save selected relation to session
            try {
                const res = await fetch('/api/form_patient', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        medical_record_num: step.selectedRelation.mrc,
                        relation: step.selectedRelation.relation,
                    })
                });
                const data = await res.json();
                if (!data.success) {
                    throw new Error(data.message);
                }

                step.currentStatus = STATUS.SUCCESS;
                await this.delay(300);
                step.completed = true;
                this.nextStep();

            } catch (err) {
                step.error = err instanceof TypeError ? networkError : err.message;
                return;
            }

            step.currentStatus = STATUS.IDLE;
        },


        // ========== Symptom Step ==========
        toggleSymptom(topic) {
            const step = this.steps[2];
            const idx = step.selectedSymptoms.indexOf(topic);
            if (idx > -1) {
                step.selectedSymptoms.splice(idx, 1);
            } else {
                step.selectedSymptoms.push(topic);
            }
            step.showPrefillMsg = false;
        },

        showPopover(region, event, posType) {
            const step = this.steps[2];
            if (step.activeRegion === region) {
                step.activeRegion = null;
                return;
            }
            step.activeRegion = region;

            const hotspotEl = event.currentTarget;
            const layoutEl = document.getElementById('image-wrapper');
            if (!hotspotEl || !layoutEl) return;

            this.$nextTick(() => {
                setTimeout(() => {
                    const popoverEl = document.getElementById('popover');
                    if (!popoverEl) return;

                    const layoutRect = layoutEl.getBoundingClientRect();
                    const spotRect = hotspotEl.getBoundingClientRect();
                    const popoverRect = popoverEl.getBoundingClientRect();

                    const spotCenterY = (spotRect.top + spotRect.bottom) / 2 - layoutRect.top;

                    let top = spotCenterY - popoverRect.height / 2;
                    const maxTop = layoutRect.height - popoverRect.height - 15;
                    top = Math.max(0, Math.min(top, maxTop));
                    step.popoverTop = top;

                    let arrow = spotCenterY - top;
                    arrow = Math.max(20, Math.min(arrow, popoverRect.height - 20));
                    step.arrowTop = arrow + 'px';

                    let spotLeft = spotRect.left - layoutRect.left;
                    let spotRight = spotRect.right - layoutRect.left;

                    if (posType === 'body') {
                        step.popoverLeft = spotRight + 6;
                        step.popoverArrowClass = 'arrow-left';
                    } else {
                        step.popoverLeft = spotLeft - 226;
                        step.popoverArrowClass = 'arrow-right';
                    }
                }, 50);
            });
        },

        async confirmSymptoms() {
            const step = this.steps[2];
            if (step.selectedSymptoms.length < 1) return;
            
            try {
                const res = await fetch('/api/form_symptoms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symptoms: step.selectedSymptoms,
                    })
                });
                const data = await res.json();
                if (!data.success) {
                    throw new Error(data.message);
                }

                step.currentStatus = STATUS.SUCCESS
                await this.delay(300);
                step.value = step.selectedSymptoms.join(', ');
                step.completed = true;
                this.nextStep();
                
            } catch (err) {
                step.error = err instanceof TypeError ? networkError : err.message;
            }

            step.currentStatus = STATUS.IDLE;
        },



        // ========== Review Step ==========
        async submitForm() {
            const step = this.steps[3];

            step.currentStatus = STATUS.LOADING;
            step.error = '';

            try {
                const res = await fetch('/api/form_submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const data = await res.json();

                await this.delay(1000);
                if (!data.success) {
                    throw new Error(data.message);
                }
                
                if (data.redirect) {
                    window.location.href = data.redirect;
                    this.steps = initSteps();
                    this.currentStep = 0;
                }

            } catch (err) {
                step.error = err instanceof TypeError ? networkError : err.message;
            }

            step.currentStatus = STATUS.IDLE;
        },

        init() {
            // Retrieve doctor and pairing info from window variables (injected by Flask)
            const doctor = window.doctorInfo;
            if (doctor) {
                const authStep = this.steps[0];
                authStep.doctorName = doctor.doctor_name;
                authStep.doctorDept = doctor.department;
                authStep.completed = true;
                authStep.authed = true;
                if (this.currentStep === 0) this.currentStep = 1;
            }

            const pairing = window.pairingInfo;
            if (pairing) {
                const pairStep = this.steps[1];
                pairStep.lineUname = pairing.line_uname;
                pairStep.lineUuid = pairing.line_uuid;
                pairStep.savedRelations = pairing.relations || [];
                pairStep.paired = true;

                // Default selection (same logic as post-pair)
                pairStep.hasSelf = pairStep.savedRelations.some(r => r.relation === '帳號本人');
                if (!pairStep.hasSelf) {
                    pairStep.savedRelations.unshift({ relation: '帳號本人', medical_record_num: '' });
                }
                pairStep.savedRelations.sort((a, b) => (a.relation === '帳號本人') ? -1 : (b.relation === '帳號本人') ? 1 : 0);
                pairStep.selectedIdx = 0;

                // If patient was previously confirmed, restore full progress
                if (pairing.selected_mrc && pairing.selected_relation) {
                    const restoredIdx = pairStep.savedRelations.findIndex(r => r.relation === pairing.selected_relation);
                    pairStep.selectedRelation = {
                        type: 'existing_' + (restoredIdx >= 0 ? restoredIdx : 0),
                        relation: pairing.selected_relation,
                        mrc: pairing.selected_mrc,
                    };
                    pairStep.completed = true;
                    if (this.currentStep <= 1) this.currentStep = 2;

                    const symptomStep = this.steps[2];
                    if (pairing.symptoms && pairing.symptoms.length > 0) {
                        // Symptoms already saved — jump straight to review
                        symptomStep.selectedSymptoms = [...pairing.symptoms];
                        symptomStep.completed = true;
                        if (this.currentStep <= 2) this.currentStep = 3;
                    }
                } else {
                    // Prefill symptom selection from last session if available
                    if (pairing.symptoms && pairing.symptoms.length > 0) {
                        const symptomStep = this.steps[2];
                        symptomStep.selectedSymptoms = [...pairing.symptoms];
                        symptomStep.sessionLoaded = true;
                    }
                }
            }
        },
    }));
});