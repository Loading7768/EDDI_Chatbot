const initSteps = () => ([
    // completed: tracks progress
    // mode:      control current state of the card
    // value:     holds input data
    {
        key: 'auth',
        completed: false,
        error: null,
        currentStatus: 'idle',

        authed: false,
        draft: {
            account:'',
            password: '',
        },

        doctorName: '',
        doctorDept: '',
    },
    {
        key: 'pair',
        completed: false,
        error: null,
        currentStatus: 'idle',
        
        paired: false,
        pairingCode: '',

        lineUname: '',
        savedRelations: [],
        hasSelf: false,
        selectedIdx: 0,
        draft: {
            self: { mrc: '' },
            new: { relation: '', mrc: '' }
        },
        selectedRelation: { relation: '', mrc: '' },

        lineUuid: '',
    },
    {
        key: 'symptoms',
        completed: false,
        error: null,
        currentStatus: 'idle',

        selectedSymptoms: [],
        sessionLoaded: false,
        showPrefillMsg: false,
        topicMapping: {
            '頭': ['頭暈', '流鼻血', '發燒', '頭痛', '偏頭痛', '噁心嘔吐', '眩暈'],
            '脖子': ['咳嗽', '咳血', '打嗝'],
            '手': [],
            '軀幹上半部': ['胸痛', '心悸', '呼吸急促/呼吸困難', '上背痛'],
            '軀幹下半部': ['腹痛', '腸胃炎/病毒性腸胃炎', '便秘', '腹瀉', '腰痛', '吐血、解黑便、解血便、胃腸道出血', '血尿', '下背痛', '尿滯留', '懷孕早期陰道出血', '懷孕後期陰道出血', '月經週期間陰道出血'],
            '腳': [],
            '皮膚': ['燒燙傷', '水腫', '皮膚疹子(皮疹)'],
            '精神': ['譫妄、意識混亂', '虛弱', '暈厥、暈倒'],
            '其他': ['高血壓', '肌肉、關節和骨骼疼痛', '癲癇', '休克', '一般外傷、鈍挫傷、扭傷、拉傷', '傷口處置原則']
        },
        activeRegion: null,
        popoverTop: 0,
        popoverLeft: 0,
        arrowTop: '18px',
        popoverArrowClass: 'arrow-left',
    },
    {
        key: 'review',
        completed: false,
        error: null,
        currentStatus: 'idle',
    },
]);

const STATUS = Object.freeze ({
    IDLE: 'idle',
    LOADING: 'loading',
    SUCCESS: 'success',
});

console.log('steps.js loaded.');