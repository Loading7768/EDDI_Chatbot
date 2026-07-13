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

        async nextStep() {
            if (this.currentStep < this.steps.length) {
                // next = this.currentStep + 1;
                // this.currentStep = -2;
                // await this.delay(200);
                // this.currentStep = next;
                this.runWithNodeFlip(() => {
                    this.currentStep++;
                });
            }
        },

        async jumpTo(i) {
            // this.prevStep = this.currentStep;
            // this.currentStep = -2;
            // await this.delay(200);
            // this.currentStep = i;
            // this.edit = false;
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
                authStep.error = err.message;
            }
            authStep.currentStatus = STATUS.IDLE;
        },

        async confirmLogout() {
            const authStep = this.steps[0];
            authStep.currentStatus = STATUS.LOADING;

            try {
                await fetch('api/form_logout', { method: 'POST' });
            } catch (e) { }

            await this.delay(1000);
            authStep.currentStatus = STATUS.SUCCESS;
            await this.delay(300);
            this.steps = initSteps();
        },

        async cancelLogout() {
            this.runWithNodeFlip(() => {
                this.currentStep = this.prevStep;
            });
            // this.currentStep = -2;
            // await this.delay(200);
            // this.currentStep = this.prevStep;
        },


        // ========== Pair Step ==========
        async confirmPair() {
            const step = this.steps[1];
            if (step.paringCode.length < 6) return;

            step.currentStatus = STATUS.LOADING;
            step.error = '';

            try {
                const res = await fetch('/api/form_pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: step.paringCode })
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
                step.relations = data.relations || [];
                step.paired = true;

                const hasSelf = step.relations.some(r => r.relation === '帳號本人');
                if (!hasSelf) {
                    step.relations.unshift({ relation: '帳號本人', medical_record_num: '' });
                }
                step.relations.sort((a, b) => (a.relation === '帳號本人') ? -1 : (b.relation === '帳號本人') ? 1 : 0);
                step.selectedRelation = { type: 'existing_0', relation: step.relations[0].relation, mrc: step.relations[0].medical_record_num };
                
            } catch (err) {
                step.error = err.message;
                step.paringCode = '';
            }
            step.currentStatus = STATUS.IDLE;
        },

        async confirmPatient() {
            const step = this.steps[1];
            if (!step.selectedRelation) return;
            step.pairSelectError = '';

            // Resolve effective mrc: for 帳號本人 with blank mrc, use draft input
            let effectiveMrc = step.selectedRelation.mrc;
            const isSelfInput = step.selectedRelation.type.startsWith('existing')
                && step.selectedRelation.relation === '帳號本人'
                && !step.selectedRelation.mrc;
            if (isSelfInput) {
                effectiveMrc = step.draft.self.mrc.trim();
            }

            // Validate
            if (isSelfInput && !effectiveMrc) return;
            if (step.selectedRelation.type === 'new' && (!step.selectedRelation.mrc || !step.selectedRelation.relation)) return;

            if (isSelfInput || step.selectedRelation.type === 'new') {
                const rel = isSelfInput ? '帳號本人' : step.selectedRelation.relation.trim();
                const mrc = isSelfInput ? effectiveMrc : step.selectedRelation.mrc.trim();

                if (step.selectedRelation.type === 'new' && (rel === '新增' || rel === '帳號本人')) {
                    step.pairSelectError = '稱呼和病歷號不可重複';
                    return;
                }

                const isDup = step.relations.some(r => r.relation !== '帳號本人' && (r.relation === rel || r.medical_record_num === mrc));
                if (isDup) {
                    step.pairSelectError = '稱呼和病歷號不可重複';
                    return;
                }
            }

            let text = '';
            let matchedRelationObj = null;
            if (step.selectedRelation.type.startsWith('existing')) {
                const idx = parseInt(step.selectedRelation.type.split('_')[1]);
                matchedRelationObj = step.relations[idx];
                text = step.selectedRelation.relation;
            } else {
                text = step.selectedRelation.relation || '？？？';
            }

            const finalMrc = effectiveMrc || step.selectedRelation.mrc;

            // Prefill selection based on patient
            const symptomStep = this.steps[2];
            if (symptomStep.sessionLoaded) {
                symptomStep.sessionLoaded = false;
            } else {
                if (matchedRelationObj && matchedRelationObj.prefilled_symptoms && matchedRelationObj.prefilled_symptoms.length > 0) {
                    symptomStep.selectedSymptoms = [...matchedRelationObj.prefilled_symptoms];
                    symptomStep.showPrefillMsg = true;
                } else {
                    symptomStep.selectedSymptoms = [];
                    symptomStep.showPrefillMsg = false;
                }
            }

            step.currentStatus = STATUS.SUCCESS;
            await this.delay(300);
            step.selectedRelation.mrc = finalMrc;
            step.value = `${text} (${finalMrc})`;
            step.completed = true;
            this.nextStep();
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
            const pairStep = this.steps[1];
            if (step.selectedSymptoms.length < 1) return;

            const selectedRelation = pairStep.selectedRelation;
            const mrc = selectedRelation?.mrc?.trim() || '';
            const relation = selectedRelation?.type === 'self' ? '帳號本人' : (selectedRelation?.relation?.trim() || '');
            
            try {
                const res = await fetch('/api/form_discharge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symptoms: step.selectedSymptoms,
                        medical_record_num: mrc,
                        relation: relation,
                    })
                });
                const data = await res.json();
                if (data.success) {
                    step.currentStatus = STATUS.SUCCESS
                    await this.delay(300);
                    step.value = step.selectedSymptoms.join(', ');
                    step.completed = true;
                    this.nextStep();
                    step.currentStatus = STATUS.IDLE;
                }
            } catch (e) {
                console.error('Error saving symptoms:', e);
            }
        },



        // ========== Review Step ==========
        async submitForm() {
            const step = this.steps[3];
            const pairStep = this.steps[1];

            step.currentStatus = STATUS.LOADING;
            step.error = '';

            const selectedRelation = pairStep.selectedRelation;
            const mrc = selectedRelation?.mrc?.trim();
            const relation = selectedRelation?.type === 'self' ? '帳號本人' : selectedRelation?.relation?.trim();

            try {
                const res = await fetch('/api/form_submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        medical_record_num: mrc,
                        relation: relation,
                    })
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
                step.error = err.message;
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
                pairStep.relations = pairing.relations || [];
                pairStep.paired = true;

                // Default selection (same logic as post-pair)
                const hasSelf = pairStep.relations.some(r => r.relation === '帳號本人');
                if (!hasSelf) {
                    pairStep.relations.unshift({ relation: '帳號本人', medical_record_num: '' });
                }
                pairStep.relations.sort((a, b) => (a.relation === '帳號本人') ? -1 : (b.relation === '帳號本人') ? 1 : 0);
                pairStep.selectedRelation = { type: 'existing_0', relation: pairStep.relations[0].relation, mrc: pairStep.relations[0].medical_record_num };

                // If patient was previously confirmed, restore full progress
                if (pairing.selected_mrc && pairing.selected_relation) {
                    const restoredIdx = pairStep.relations.findIndex(r => r.relation === pairing.selected_relation);
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