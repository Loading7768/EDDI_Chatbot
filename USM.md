Viewed SRD.md:1-65

根據 **EDDI Chatbot SRD** 的內容，我為您整理了這份 **使用者故事地圖 (User Story Map)**。這份地圖將系統功能拆解為四大活動領域，並詳細描述了不同角色的操作流程與價值。

### 使用者故事地圖描述

1.  **活動一：病患醫囑範疇設定 (醫師端)**
    *   **任務**：身分驗證、輸入病患資料、界定衛教範圍。
    *   **價值**：確保機器人的回答僅限於該病患特定的醫療範疇，並防止非授權存取。

2.  **活動二：醫囑諮詢互動 (病患端)**
    *   **任務**：身分自動關聯、對話詢問、獲取 RAG 回覆。
    *   **價值**：讓病患能隨時隨地獲取精準且符合醫囑的衛教解答，減輕急診後的焦慮。

3.  **活動三：主動預警與通知 (系統/醫師端)**
    *   **任務**：回診需求判定、即時訊息推播。
    *   **價值**：在病患出現異常或需要回診時，第一時間主動告知醫師，強化醫病聯繫。

4.  **活動四：數據分析與系統優化 (醫師/技術端)**
    *   **任務**：查看遙測數據、回診統計、標記錯誤回覆。
    *   **價值**：透過臨床反饋優化 AI 表現，並掌握病患在院外的恢復追蹤狀況。

---

### Mermaid 流程圖

```mermaid
graph TD
    subgraph Activities["使用者故事地圖 (User Story Map)"]
        direction TB
        
        %% Activity 1: Doctor Setup
        A1[活動一：醫囑設定] --> T1_1[任務：系統登入]
        A1 --> T1_2[任務：資料輸入]
        
        T1_1 --> S1_1_1(故事：醫師輸入通行碼驗證)
        T1_2 --> S1_2_1(故事：輸入病患基本資訊與主述)
        T1_2 --> S1_2_2(故事：勾選症狀範疇界定 AI 限制)
    end

    %% Styles
    style A1 fill:#f9f,stroke:#333,stroke-width:2px
    
    style T1_1 fill:#fff,stroke:#333
    style T1_2 fill:#fff,stroke:#333
```

```mermaid
graph TD
    subgraph Activities["使用者故事地圖 (User Story Map)"]
        direction TB
		%% Activity 2: Patient Interaction
        A2[活動二：醫囑諮詢] --> T2_1[任務：身分關聯]
        A2 --> T2_2[任務：對話互動]
        
        T2_1 --> S2_1_1(故事：系統自動關聯 LINE ID)
        T2_2 --> S2_2_1(故事：病患詢問症狀相關問題)
        T2_2 --> S2_2_2(故事：獲得基於知識文件的 AI 回覆)
    end

    %% Styles
    style A2 fill:#bbf,stroke:#333,stroke-width:2px
    
    style T2_1 fill:#fff,stroke:#333
    style T2_2 fill:#fff,stroke:#333
```

```mermaid
graph TD
    subgraph Activities["使用者故事地圖 (User Story Map)"]
        direction TB
        
		%% Activity 3: Monitoring & Alert
        A3[活動三：預警通知] --> T3_1[任務：異常判定]
        A3 --> T3_2[任務：即時預警]
        
        T3_1 --> S3_1_1(故事：機器人判斷是否需要回診)
        T3_2 --> S3_2_1(故事：主動發送推播訊息給醫師)

    end

    %% Styles
    style A3 fill:#bfb,stroke:#333,stroke-width:2px
    
    style T3_1 fill:#fff,stroke:#333
    style T3_2 fill:#fff,stroke:#333
```

```mermaid
graph TD
    subgraph Activities["使用者故事地圖 (User Story Map)"]
        direction TB
        %% Activity 4: Analytics & Maintenance
        A4[活動四：數據與優化] --> T4_1[任務：遙測追蹤]
        A4 --> T4_2[任務：品質標記]
        
        T4_1 --> S4_1_1(故事：查看對話率與回診統計)
        T4_2 --> S4_2_1(故事：醫師勾選錯誤回覆)
        T4_2 --> S4_2_2(故事：紀錄匯出為 CSV 供校正)
    end

    %% Styles
    style A4 fill:#ffb,stroke:#333,stroke-width:2px
    
    style T4_1 fill:#fff,stroke:#333
    style T4_2 fill:#fff,stroke:#333
```

這份地圖清楚地展示了從醫師設定、病患互動到最後的數據回饋閉環。您可以將此 Mermaid 代碼直接貼到 Markdown 閱讀器中渲染查看。