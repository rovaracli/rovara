import { useIsFetching,useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design/Button.js";
/** A read, never a replay of the consequential write. */
export function AgentStatusCheck({id}:{id:string}){const query=useQueryClient(),key=["agent",id],checking=useIsFetching({queryKey:key,exact:true});return <Button busy={checking>0} onClick={()=>{void query.refetchQueries({queryKey:key,exact:true,type:"all"},{cancelRefetch:false});}}>Check status</Button>;}
